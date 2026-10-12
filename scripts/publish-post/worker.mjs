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
 * Keeps the state entry of a channel in step with what is sent for it.
 * @param {import("./state.mjs").StateEntry} entry
 * @param {() => Promise<void>} save
 */
function track(entry, save) {
  /** Where the channel stands now: the step and what belongs to it. */
  const set = (fields) => {
    for (const key of ["mediaId", "postId", "status", "message"])
      delete entry[key];
    Object.assign(entry, fields);
  };
  return {
    set,
    /**
     * The step written before a request. When the write fails the request
     * is not sent, so the step is taken back: a later write, of another
     * channel, must not record a step this channel never reached.
     */
    async before(fields) {
      const earlier = { ...entry };
      set(fields);
      try {
        await save();
      } catch (cause) {
        for (const key of Object.keys(entry)) delete entry[key];
        Object.assign(entry, earlier);
        throw cause;
      }
    },
  };
}

/**
 * Uploads the image of a channel, unless an earlier run already did.
 * @returns {Promise<{ mediaId: string } | { failure: object }>} the media ID,
 *   or what to report when there is none
 */
async function uploadImage(plan, run, steps, label) {
  const { entry } = plan;
  if (entry.step === "uploaded" && entry.mediaId)
    return { mediaId: entry.mediaId };

  await steps.before({ step: "uploading" });
  const answer = await callWorker(
    run.context,
    buildUploadRequest(run.credentials, plan.image.bytes),
  );
  run.log(`${label}: upload ${answer.status || "no answer"}`);
  const uploaded =
    answer.status === 200 ? uploadSchema.safeParse(answer.data) : undefined;
  if (!uploaded?.success) {
    const outcome = isRefusal(answer.status) ? "refused" : "failed";
    const failure = {
      ...(answer.status ? { status: answer.status } : {}),
      message: `Upload: ${answer.status === 200 ? "the Worker answered without a media ID." : answer.message}`,
    };
    steps.set({ step: outcome, ...failure });
    await run.save();
    return { failure: { outcome, ...failure } };
  }
  const { mediaId } = uploaded.data;
  steps.set({ step: "uploaded", mediaId });
  await run.save();
  return { mediaId };
}

/** Sends the post of a channel and records what came back. */
async function createPost(plan, run, steps, label, mediaId) {
  const { channel, entry } = plan;
  const request = buildPostRequest(run.credentials, {
    requestId: entry.requestId,
    mediaId,
    channelId: channel.id,
    text: plan.text,
    mode: run.mode,
    ...(run.dueAt ? { dueAt: run.dueAt } : {}),
  });
  await steps.before({ step: "posting", mediaId });
  const answer = await callWorker(run.context, request);
  run.log(`${label}: post ${answer.status || "no answer"}`);

  const { outcome, ...result } = classifyPost(answer);
  if (result.status === 0) delete result.status;
  // An unknown result keeps the step at "posting", which blocks a repeat.
  steps.set({
    step: outcome === "unknown" ? "posting" : outcome,
    mediaId,
    ...result,
  });
  try {
    await run.save();
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

/**
 * Uploads and posts for one channel. The state is written before each request,
 * so a run that dies in the middle leaves a trace of how far it got.
 * @param {import("./plan.mjs").ChannelPlan} plan
 * @param {object} run the session's context, the credentials, the state
 *   writer and the log of this run
 */
export async function sendChannel(plan, run) {
  const { channel, entry } = plan;
  const label = `${channel.service} (${channel.id})`;
  const steps = track(entry, run.save);

  const upload = await uploadImage(plan, run, steps, label);
  if ("failure" in upload) return upload.failure;
  return createPost(plan, run, steps, label, upload.mediaId);
}
