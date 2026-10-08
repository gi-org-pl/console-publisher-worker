import { z } from "zod";
import {
  MAX_SCHEDULE_DAYS,
  MIN_SCHEDULE_LEAD_MS,
  type PublishInput,
  publishInputSchema,
} from "../schemas/publishing";
import { createBufferPost } from "./buffer";
import { error, json, readLimited } from "./http";
import { actorFields, logError, logEvent } from "./log";
import { imageKey } from "./media";
import { minScheduleLeadMs, modeAllowed } from "./policy";
import type { Channel, Env, Operator } from "./types";

const MAX_BODY_BYTES = 24_000;
const DAY_MS = 86_400_000;

const receiptSchema = z.object({
  owner: z.string(),
  service: z.string().optional(),
  fingerprint: z.string(),
  postId: z.string().optional(),
});

function receiptKey(input: PublishInput): string {
  return `receipts/${input.requestId}`;
}

/** Ties a request ID to its exact content, so a changed retry is refused. */
function fingerprint(input: PublishInput): string {
  return JSON.stringify(input);
}

function receipt(
  operator: Operator,
  input: PublishInput,
  postId?: string,
): string {
  return JSON.stringify({
    owner: operator.subject,
    ...(operator.kind === "service" ? { service: operator.name } : {}),
    fingerprint: fingerprint(input),
    postId,
  });
}

/**
 * A refused service request can mean the automation was steered by content
 * someone planted for it, so every refusal of a restriction leaves a trace.
 */
function serviceDenied(
  operator: Operator,
  input: PublishInput,
  reason: string,
): void {
  if (operator.kind === "service") {
    logError("service-post-denied", new Error(reason), {
      requestId: input.requestId,
      channelId: input.channelId,
      mode: input.mode,
      ...actorFields(operator),
    });
  }
}

async function parseInput(request: Request): Promise<PublishInput | Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  ) {
    return error("JSON required.", 415);
  }

  try {
    const bytes = await readLimited(request, MAX_BODY_BYTES);
    return publishInputSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch (cause) {
    logError("post-input-rejected", cause);
    return error("Check the post text and settings.", 400);
  }
}

function scheduleError(
  input: PublishInput,
  minLeadMs: number,
): Response | undefined {
  if (input.mode !== "customScheduled") {
    return input.dueAt ? error("Invalid schedule time.", 400) : undefined;
  }

  const dueAt = Date.parse(input.dueAt ?? "");
  const now = Date.now();
  if (
    Number.isNaN(dueAt) ||
    dueAt < now + minLeadMs ||
    dueAt > now + MAX_SCHEDULE_DAYS * DAY_MS
  ) {
    const earliest =
      minLeadMs === MIN_SCHEDULE_LEAD_MS
        ? "one minute"
        : `${minLeadMs / 60_000} minutes`;
    return error(
      `Choose a time from ${earliest} to ${MAX_SCHEDULE_DAYS} days from now.`,
      400,
    );
  }
}

async function reserveRequest(
  env: Env,
  operator: Operator,
  input: PublishInput,
): Promise<Response | undefined> {
  const key = receiptKey(input);
  const reserved = await env.MEDIA.put(key, receipt(operator, input), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (reserved) {
    return undefined;
  }

  const previous = await env.MEDIA.get(key);
  const stored = previous && receiptSchema.safeParse(await previous.json());
  if (
    stored?.success &&
    stored.data.owner === operator.subject &&
    stored.data.fingerprint === fingerprint(input) &&
    stored.data.postId
  ) {
    return json({ postId: stored.data.postId });
  }

  return error(
    "This request was already sent. Check Buffer before creating another post.",
    409,
  );
}

export async function createPost(
  request: Request,
  env: Env,
  operator: Operator,
  channels: Channel[],
): Promise<Response> {
  const input = await parseInput(request);
  if (input instanceof Response) {
    return input;
  }

  if (!modeAllowed(operator, input.mode)) {
    serviceDenied(operator, input, "Mode not allowed for a service");
    return error("A service may only queue or schedule a post.", 403);
  }

  const channel = channels.find((entry) => entry.id === input.channelId);
  if (!channel) {
    serviceDenied(operator, input, "Channel not allowed");
    return error("This channel is not allowed.", 403);
  }

  const schedule = scheduleError(input, minScheduleLeadMs(operator));
  if (schedule) {
    serviceDenied(operator, input, "Schedule time not allowed");
    return schedule;
  }

  const media = await env.MEDIA.head(imageKey(input.mediaId));
  if (!media || media.customMetadata?.owner !== operator.subject) {
    return error("The image expired or belongs to another operator.", 403);
  }

  const replay = await reserveRequest(env, operator, input);
  if (replay) {
    return replay;
  }

  const context = {
    requestId: input.requestId,
    channelId: channel.id,
    ...actorFields(operator),
  };
  let postId: string;
  try {
    postId = await createBufferPost(env, input, channel);
  } catch (cause) {
    // A timeout can occur after Buffer accepted the mutation. Never auto-retry.
    logError("buffer-post-unconfirmed", cause, context);
    return error(
      "Buffer did not confirm the post. Check the Buffer queue and history before publishing again.",
      502,
    );
  }

  logEvent("buffer-post-created", { ...context, postId });

  try {
    await env.MEDIA.put(receiptKey(input), receipt(operator, input, postId));
  } catch (cause) {
    // The post exists, so report it. An identical retry then gets 409, not a replay.
    logError("receipt-write-failed", cause, { ...context, postId });
  }

  return json({ postId });
}
