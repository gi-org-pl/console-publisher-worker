import { sessionSchema, uploadSchema } from "../../src/schemas/publishing.ts";
import { ClientError } from "./errors.mjs";
import { redact } from "./redaction.mjs";
import {
  buildPostRequest,
  buildSessionRequest,
  buildUploadRequest,
  classifyPost,
  isRefusal,
} from "./requests.mjs";

// Talking to the Worker: one request, the session, and the upload and the
// post of one channel.

const MAX_MESSAGE_LENGTH = 500;

function describeFailure(cause, timeoutMs) {
  if (cause?.name === "TimeoutError" || cause?.name === "AbortError")
    return `no answer within ${timeoutMs / 1000} s`;
  const detail = cause?.cause?.code ?? cause?.cause?.message;
  return `${cause?.message ?? cause}${detail ? ` (${detail})` : ""}`;
}

/**
 * Sends one request. Whatever happens comes back as `{ status, data, message }`
 * with status 0 when no answer arrived. Redirects are not followed: the
 * credential headers must never travel to another host.
 */
export async function callWorker(context, request) {
  let response;
  try {
    response = await context.fetch(new URL(request.path, context.baseUrl), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(context.timeoutMs),
    });
  } catch (cause) {
    return {
      status: 0,
      message: `No answer from ${context.baseUrl}: ${describeFailure(cause, context.timeoutMs)}.`,
    };
  }

  const { status } = response;
  if (status >= 300 && status < 400)
    return {
      status,
      message:
        "Redirected instead of answered: Cloudflare Access did not accept the credentials.",
    };

  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = undefined;
  }
  if (typeof data?.message === "string") {
    // The credentials are taken out before the message is cut: a cut through
    // one of them would leave a part that no later redaction can match.
    const message = redact(data.message, [
      request.headers["CF-Access-Client-Secret"],
      request.headers["CF-Access-Client-Id"],
    ]);
    return { status, data, message: message.slice(0, MAX_MESSAGE_LENGTH) };
  }
  return {
    status,
    data,
    message: `HTTP ${status} without a message from the Worker.`,
  };
}

export async function openSession(context, credentials, log) {
  const answer = await callWorker(context, buildSessionRequest(credentials));
  log(`session: ${answer.status || "no answer"}`);
  if (answer.status !== 200)
    throw new ClientError(
      "session-failed",
      answer.message,
      answer.status || undefined,
    );
  const session = sessionSchema.safeParse(answer.data);
  if (!session.success)
    throw new ClientError(
      "session-failed",
      "The session answer is not what the Worker's schema describes.",
      200,
    );
  const { channels, ...identity } = session.data;
  return { identity, channels };
}

/**
 * Uploads and posts for one channel. The state is written before each request,
 * so a run that dies in the middle leaves a trace of how far it got.
 */
export async function sendChannel(plan, run) {
  const { context, credentials, save, log } = run;
  const { channel, entry } = plan;
  const label = `${channel.service} (${channel.id})`;
  const set = (fields) => {
    for (const key of ["mediaId", "postId", "status", "message"])
      delete entry[key];
    Object.assign(entry, fields);
  };
  // The step written before a request. When the write fails the request is
  // not sent, so the step is taken back: a later write, of another channel,
  // must not record a step this channel never reached.
  const mark = async (fields) => {
    const before = { ...entry };
    set(fields);
    try {
      await save();
    } catch (cause) {
      for (const key of Object.keys(entry)) delete entry[key];
      Object.assign(entry, before);
      throw cause;
    }
  };

  let { mediaId } = entry;
  if (entry.step !== "uploaded" || !mediaId) {
    await mark({ step: "uploading" });
    const answer = await callWorker(
      context,
      buildUploadRequest(credentials, plan.image.bytes),
    );
    log(`${label}: upload ${answer.status || "no answer"}`);
    const uploaded =
      answer.status === 200 ? uploadSchema.safeParse(answer.data) : undefined;
    if (!uploaded?.success) {
      const outcome = isRefusal(answer.status) ? "refused" : "failed";
      const failure = {
        ...(answer.status ? { status: answer.status } : {}),
        message: `Upload: ${answer.status === 200 ? "the Worker answered without a media ID." : answer.message}`,
      };
      set({ step: outcome, ...failure });
      await save();
      return { outcome, ...failure };
    }
    mediaId = uploaded.data.mediaId;
    set({ step: "uploaded", mediaId });
    await save();
  }

  const request = buildPostRequest(credentials, {
    requestId: entry.requestId,
    mediaId,
    channelId: channel.id,
    text: plan.text,
    mode: run.mode,
    ...(run.dueAt ? { dueAt: run.dueAt } : {}),
  });
  await mark({ step: "posting", mediaId });
  const answer = await callWorker(context, request);
  log(`${label}: post ${answer.status || "no answer"}`);

  const { outcome, ...result } = classifyPost(answer);
  if (result.status === 0) delete result.status;
  // An unknown result keeps the step at "posting", which blocks a repeat.
  set({
    step: outcome === "unknown" ? "posting" : outcome,
    mediaId,
    ...result,
  });
  try {
    await save();
  } catch (cause) {
    const error = {
      code: cause.code,
      message: `${cause.message} The result of ${label} (${outcome}) is not in the state file: do not run this job again before the file is fixed.`,
    };
    run.errors.push(error);
    run.unsaved.push(error);
  }
  return { outcome, ...result };
}
