import { z } from "zod";
import {
  type AnnouncementInput,
  announcementInputSchema,
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

const MAX_BODY_BYTES = 8_000;

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
 * Writes an announcement. The status also goes into the object's metadata, so
 * the scheduled run can find the pending ones from a listing alone. With
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
      customMetadata: { status: announcement.status },
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
 * Takes each post for this announcement. A post another announcement holds
 * refuses the whole request, and the posts taken so far are let go again.
 */
async function claimPosts(
  env: Env,
  input: AnnouncementInput,
): Promise<boolean> {
  const taken: string[] = [];
  for (const postRequestId of input.postRequestIds) {
    const key = claimKey(postRequestId);
    const value = JSON.stringify({ announcementId: input.requestId });
    if (
      await env.MEDIA.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } })
    ) {
      taken.push(key);
      continue;
    }
    // Held already: by this announcement after an interrupted attempt, or by another one.
    const holder = await env.MEDIA.get(key);
    const claim = holder && (await holder.json<{ announcementId?: string }>());
    if (claim?.announcementId !== input.requestId) {
      await Promise.all(taken.map((done) => env.MEDIA.delete(done)));
      return false;
    }
  }
  return true;
}

/**
 * After losing the race to another request with the same ID, lets go of the
 * posts that the stored announcement does not name. Both requests hold their
 * claims under the same ID, so the ones the winner names stay.
 */
async function releaseClaims(env: Env, input: AnnouncementInput) {
  const object = await env.MEDIA.get(announcementKey(input.requestId));
  const stored = object && announcementSchema.safeParse(await object.json());
  const held = new Set(
    stored?.success ? stored.data.posts.map((post) => post.requestId) : [],
  );
  await Promise.all(
    input.postRequestIds
      .filter((postRequestId) => !held.has(postRequestId))
      .map((postRequestId) => env.MEDIA.delete(claimKey(postRequestId))),
  );
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
  const posts: AnnouncedPost[] = [];
  for (const [index, receipt] of receipts.entries()) {
    if (!receipt?.postId) {
      return error(
        "Buffer did not confirm one of the posts. Check Buffer before announcing it.",
        409,
      );
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
    return error("One of the posts already has an announcement.", 409);
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
    const answer =
      (await replay(env, operator, input)) ??
      error("This announcement was already registered.", 409);
    if (answer.status !== 200) {
      await releaseClaims(env, input);
    }
    return answer;
  }

  logEvent("announcement-registered", {
    ...context,
    postIds: posts.map((post) => post.postId),
  });
  return json(summary(announcement));
}
