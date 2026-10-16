import { z } from "zod";
import {
  ANNOUNCEMENT_MAX_IMAGES,
  ANNOUNCEMENT_MAX_POSTS,
  ANNOUNCEMENT_MAX_TEXT,
  type AnnouncementInput,
  announcementInputSchema,
  MAX_IMAGES_PER_POST,
  MAX_POST_TEXT,
} from "../schemas/publishing";
import { error, json, readLimited } from "./http";
import { actorFields, logError, logEvent } from "./log";
import { imageKey, landscapeOrSquare } from "./media";
import { readReceipt } from "./posts";
import type { Env, Operator } from "./types";

// A short Discord version of a post, registered by a service when it queues
// the post and published by the scheduled run (`cron.ts`) once Buffer has sent
// one of the posts. Only a service may register one: Console, which runs on
// an operator's browser session, has no way to publish to Discord.

/**
 * The largest body the schema allows, with room: each character of the two
 * texts can take up to 6 bytes in JSON (a `\u0000` escape), and up to 34
 * IDs of about 40 bytes each come with them.
 */
const MAX_BODY_BYTES =
  (ANNOUNCEMENT_MAX_TEXT + MAX_POST_TEXT) * 6 +
  (ANNOUNCEMENT_MAX_IMAGES + ANNOUNCEMENT_MAX_POSTS + MAX_IMAGES_PER_POST) *
    40 +
  1_000;

/**
 * Where an announcement stands. `pending` waits for Buffer; `sending` holds
 * the one attempt in progress; the others are final. `unconfirmed` means
 * Discord may have the message, so it is never sent again on its own.
 */
export const ANNOUNCEMENT_STATUSES = [
  "pending",
  "sending",
  "posted",
  "cancelled",
  "unconfirmed",
  "failed",
  "expired",
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

const announcedPostSchema = z.object({
  requestId: z.string(),
  postId: z.string(),
  dueAt: z.string().nullish(),
  /** Buffer's status at the last look, or `deleted` once Buffer no longer has it. */
  status: z.string().nullish(),
});
export type AnnouncedPost = z.infer<typeof announcedPostSchema>;

export const announcementSchema = z.object({
  id: z.string(),
  owner: z.string(),
  service: z.string(),
  fingerprint: z.string(),
  text: z.string(),
  mediaIds: z.array(z.string()),
  posts: z.array(announcedPostSchema).min(1),
  status: z.enum(ANNOUNCEMENT_STATUSES),
  createdAt: z.string(),
  checkedAt: z.string().optional(),
  attempts: z.number().int().default(0),
  lastError: z.string().optional(),
  /** Set once the message is on Discord: the receipt of the announcement. */
  posted: z
    .object({
      messageId: z.string().optional(),
      postedAt: z.string(),
      afterPostId: z.string(),
    })
    .optional(),
  closedAt: z.string().optional(),
});
export type Announcement = z.infer<typeof announcementSchema>;

export const ANNOUNCEMENT_PREFIX = "announcements/";

export function announcementKey(id: string): string {
  return `${ANNOUNCEMENT_PREFIX}${id}.json`;
}

/** Marks a post as taken by one announcement, so no second one names it. */
function claimKey(postRequestId: string): string {
  return `announcement-posts/${postRequestId}`;
}

/**
 * Writes an announcement. The status and the time of the last look at Buffer
 * also go into the object's metadata, so the scheduled run can find and order
 * the pending ones from a listing alone. With
 * `etag`, the write happens only if nobody changed the object since it was
 * read; without, only if it does not exist yet. Null means it did not happen.
 */
export function writeAnnouncement(
  env: Env,
  announcement: Announcement,
  etag?: string,
) {
  return env.MEDIA.put(
    announcementKey(announcement.id),
    JSON.stringify(announcement),
    {
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        status: announcement.status,
        // Lets a run look first at what was looked at least recently.
        ...(announcement.checkedAt
          ? { checkedAt: announcement.checkedAt }
          : {}),
      },
    },
  );
}

/** The earliest time Buffer means to send one of the posts still waiting. */
export function earliestDueAt(posts: AnnouncedPost[]): string | undefined {
  return posts
    .filter((post) => post.status !== "deleted" && post.status !== "error")
    .map((post) => post.dueAt)
    .filter((dueAt): dueAt is string => Boolean(dueAt))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

function summary(announcement: Announcement) {
  const dueAt = earliestDueAt(announcement.posts);
  return {
    announcementId: announcement.id,
    status: announcement.status,
    ...(dueAt ? { dueAt } : {}),
  };
}

/** The request a post was queued with, as its receipt holds it. */
function receiptRequest(postFingerprint: string): {
  text?: unknown;
  mediaId?: unknown;
  mediaIds?: unknown;
} {
  try {
    return JSON.parse(postFingerprint) ?? {};
  } catch {
    return {};
  }
}

/**
 * The R2 etags of the caller's images, in order: R2 derives the etag of an
 * object written in one put from its bytes, so equal etags mean equal images.
 * Undefined when one is missing or someone else's.
 */
async function imageTags(
  env: Env,
  operator: Operator,
  mediaIds: unknown,
): Promise<string[] | undefined> {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return undefined;
  }
  const images = await Promise.all(
    mediaIds.map((mediaId) => env.MEDIA.head(imageKey(String(mediaId)))),
  );
  return images.every(
    (image) => image && image.customMetadata?.owner === operator.subject,
  )
    ? images.map((image) => image?.etag ?? "")
    : undefined;
}

function fingerprint(input: AnnouncementInput): string {
  return JSON.stringify(input);
}

async function parseInput(
  request: Request,
): Promise<AnnouncementInput | Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  ) {
    return error("JSON required.", 415);
  }
  try {
    const bytes = await readLimited(request, MAX_BODY_BYTES);
    return announcementInputSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch (cause) {
    logError("announcement-input-rejected", cause);
    return error("Check the announcement text, images and posts.", 400);
  }
}

/** A retry of the same request gets the same answer; anything else under its ID is refused. */
async function replay(
  env: Env,
  operator: Operator,
  input: AnnouncementInput,
): Promise<Response | undefined> {
  const object = await env.MEDIA.get(announcementKey(input.requestId));
  if (!object) {
    return undefined;
  }
  const stored = announcementSchema.safeParse(await object.json());
  if (
    stored.success &&
    stored.data.owner === operator.subject &&
    stored.data.fingerprint === fingerprint(input)
  ) {
    return json(summary(stored.data));
  }
  return error("This announcement was already registered.", 409);
}

/**
 * How long a claim counts without an announcement that names its post: long
 * enough for a registration in progress, after which the claim was left by
 * one that stopped or lost a race.
 */
const CLAIM_HOLD_MS = 60_000;

/**
 * Whether another announcement's claim on a post still counts: its
 * announcement is stored and names the post, or the claim is too recent to
 * tell. Claims are never deleted, so one left behind is simply taken over.
 */
async function claimCounts(
  env: Env,
  announcementId: string | undefined,
  postRequestId: string,
  uploaded: Date,
): Promise<boolean> {
  if (Date.now() - uploaded.getTime() < CLAIM_HOLD_MS) {
    return true;
  }
  const object = announcementId
    ? await env.MEDIA.get(announcementKey(announcementId))
    : null;
  const stored = object && announcementSchema.safeParse(await object.json());
  return Boolean(
    stored?.success &&
      stored.data.posts.some((post) => post.requestId === postRequestId),
  );
}

/**
 * Takes each post for this announcement. A post another announcement holds
 * refuses the request; the posts taken before it keep a claim that stops
 * counting after a minute.
 */
async function claimPosts(
  env: Env,
  input: AnnouncementInput,
): Promise<boolean> {
  const value = JSON.stringify({ announcementId: input.requestId });
  for (const postRequestId of input.postRequestIds) {
    const key = claimKey(postRequestId);
    if (
      await env.MEDIA.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } })
    ) {
      continue;
    }
    const holder = await env.MEDIA.get(key);
    if (!holder) {
      return false;
    }
    const claim = await holder.json<{ announcementId?: string }>();
    // A claim of this ID is from an earlier attempt of the same request. One
    // that is getting old is renewed first, so nobody takes it over while
    // this registration finishes; a renewal that misses means someone did.
    if (claim.announcementId === input.requestId) {
      if (
        Date.now() - holder.uploaded.getTime() >= CLAIM_HOLD_MS / 2 &&
        !(await env.MEDIA.put(key, value, {
          onlyIf: { etagMatches: holder.etag },
        }))
      ) {
        return false;
      }
      continue;
    }
    if (
      (await claimCounts(
        env,
        claim.announcementId,
        postRequestId,
        holder.uploaded,
      )) ||
      // Taken over only if nobody else took it over meanwhile.
      !(await env.MEDIA.put(key, value, {
        onlyIf: { etagMatches: holder.etag },
      }))
    ) {
      return false;
    }
  }
  return true;
}

export async function registerAnnouncement(
  request: Request,
  env: Env,
  operator: Operator,
): Promise<Response> {
  if (operator.kind !== "service") {
    // Console runs on the operator's session; publishing to Discord is not open to it.
    logError(
      "announcement-denied",
      new Error("Not a service"),
      actorFields(operator),
    );
    return error(
      "Only an allowlisted service may register an announcement.",
      403,
    );
  }

  const input = await parseInput(request);
  if (input instanceof Response) {
    return input;
  }
  const context = { announcementId: input.requestId, ...actorFields(operator) };

  const media = await Promise.all(
    input.mediaIds.map((mediaId) => env.MEDIA.head(imageKey(mediaId))),
  );
  if (
    media.some(
      (image) => !image || image.customMetadata?.owner !== operator.subject,
    )
  ) {
    return error("The image expired or belongs to another operator.", 403);
  }
  if (media.some((image) => !landscapeOrSquare(image?.customMetadata))) {
    return error("An announcement image has to be landscape or square.", 400);
  }

  const receipts = await Promise.all(
    input.postRequestIds.map((requestId) => readReceipt(env, requestId)),
  );
  if (receipts.some((receipt) => receipt?.owner !== operator.subject)) {
    logError(
      "announcement-denied",
      new Error("A post is unknown or belongs to someone else"),
      context,
    );
    return error("Only posts this service created can be announced.", 403);
  }
  const expectedImages =
    input.postMediaIds && (await imageTags(env, operator, input.postMediaIds));
  if (input.postMediaIds && !expectedImages) {
    return error("The image expired or belongs to another operator.", 403);
  }
  const posts: AnnouncedPost[] = [];
  for (const [index, receipt] of receipts.entries()) {
    if (!receipt?.postId) {
      return error(
        "Buffer did not confirm one of the posts. Check Buffer before announcing it.",
        409,
      );
    }
    const queued = receiptRequest(receipt.fingerprint);
    if (input.postText !== undefined && queued.text !== input.postText) {
      return error(
        "One of the posts was queued with another text. A changed post needs a new name.",
        409,
      );
    }
    if (expectedImages) {
      const tags = await imageTags(
        env,
        operator,
        queued.mediaIds ?? (queued.mediaId ? [queued.mediaId] : undefined),
      );
      if (tags?.join() !== expectedImages.join()) {
        return error(
          "One of the posts was queued with other images. A changed post needs a new name.",
          409,
        );
      }
    }
    posts.push({
      requestId: input.postRequestIds[index],
      postId: receipt.postId,
      dueAt: receipt.dueAt ?? null,
      status: receipt.status ?? null,
    });
  }

  const previous = await replay(env, operator, input);
  if (previous) {
    return previous;
  }
  if (!(await claimPosts(env, input))) {
    return error(
      "One of the posts already has an announcement. A claim left by a registration that stopped is free again after a minute.",
      409,
    );
  }

  const announcement: Announcement = {
    id: input.requestId,
    owner: operator.subject,
    service: operator.name,
    fingerprint: fingerprint(input),
    text: input.text,
    mediaIds: input.mediaIds,
    posts,
    status: "pending",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  if (!(await writeAnnouncement(env, announcement))) {
    // Another request with this ID got there first.
    return (
      (await replay(env, operator, input)) ??
      error("This announcement was already registered.", 409)
    );
  }

  logEvent("announcement-registered", {
    ...context,
    postIds: posts.map((post) => post.postId),
  });
  return json(summary(announcement));
}
