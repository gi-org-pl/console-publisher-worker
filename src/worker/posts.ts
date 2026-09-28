import { z } from "zod";
import {
  MAX_SCHEDULE_DAYS,
  MIN_SCHEDULE_LEAD_MS,
  type PublishInput,
  publishInputSchema,
} from "../schemas/publishing";
import { createBufferPost } from "./buffer";
import { error, json, readLimited } from "./http";
import { logError, logEvent } from "./log";
import { imageKey } from "./media";
import type { Channel, Env, Operator } from "./types";

const MAX_BODY_BYTES = 24_000;
const DAY_MS = 86_400_000;

const receiptSchema = z.object({
  owner: z.string(),
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
    fingerprint: fingerprint(input),
    postId,
  });
}

async function parseInput(request: Request): Promise<PublishInput | Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  ) {
    return error("Wymagany JSON.", 415);
  }

  try {
    const bytes = await readLimited(request, MAX_BODY_BYTES);
    return publishInputSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch (cause) {
    logError("post-input-rejected", cause);
    return error("Sprawdź treść i ustawienia posta.", 400);
  }
}

function scheduleError(input: PublishInput): Response | undefined {
  if (input.mode !== "customScheduled") {
    return input.dueAt ? error("Nieprawidłowy termin.", 400) : undefined;
  }

  const dueAt = Date.parse(input.dueAt ?? "");
  const now = Date.now();
  if (
    Number.isNaN(dueAt) ||
    dueAt < now + MIN_SCHEDULE_LEAD_MS ||
    dueAt > now + MAX_SCHEDULE_DAYS * DAY_MS
  ) {
    return error(
      `Wybierz termin od minuty do ${MAX_SCHEDULE_DAYS} dni w przyszłości.`,
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
    "Żądanie było już wysłane. Sprawdź Buffer przed utworzeniem kolejnego posta.",
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

  const channel = channels.find((entry) => entry.id === input.channelId);
  if (!channel) {
    return error("Ten kanał nie jest dozwolony.", 403);
  }

  const schedule = scheduleError(input);
  if (schedule) {
    return schedule;
  }

  const media = await env.MEDIA.head(imageKey(input.mediaId));
  if (!media || media.customMetadata?.owner !== operator.subject) {
    return error("Grafika wygasła lub należy do innego użytkownika.", 403);
  }

  const replay = await reserveRequest(env, operator, input);
  if (replay) {
    return replay;
  }

  const context = { requestId: input.requestId, channelId: channel.id };
  let postId: string;
  try {
    postId = await createBufferPost(env, input, channel);
  } catch (cause) {
    // A timeout can occur after Buffer accepted the mutation. Never auto-retry.
    logError("buffer-post-unconfirmed", cause, context);
    return error(
      "Buffer nie potwierdził utworzenia posta. Sprawdź kolejkę i historię w Buffer przed ponowną publikacją.",
      502,
    );
  }

  logEvent("buffer-post-created", {
    ...context,
    email: operator.email,
    postId,
  });

  try {
    await env.MEDIA.put(receiptKey(input), receipt(operator, input, postId));
  } catch (cause) {
    // The post exists, so report it. An identical retry then gets 409, not a replay.
    logError("receipt-write-failed", cause, { ...context, postId });
  }

  return json({ postId });
}
