import {
  publishResultSchema,
  uploadSchema,
} from "../../src/schemas/publishing.ts";
import { body } from "./plan.mjs";
import { redact } from "./serviceToken.mjs";

// Talking to the Console: one request, and the upload and the post of one
// channel with what the answer means.

/** One request to the Console. A service sends no `Origin` and follows no redirect. */
export async function ask(
  { deps, token, secrets },
  { method = "GET", route, type, payload },
) {
  let response;
  try {
    response = await deps.fetch(new URL(route, deps.baseUrl), {
      method,
      headers: {
        "CF-Access-Client-Id": token.clientId,
        "CF-Access-Client-Secret": token.clientSecret,
        ...(type ? { "Content-Type": type } : {}),
      },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (cause) {
    return {
      status: 0,
      message: `No answer from the Console: ${cause instanceof Error ? cause.message : String(cause)}.`,
    };
  }
  const data = await response.json().catch(() => undefined);
  const said =
    typeof data?.message === "string"
      ? data.message
      : `The Console answered ${response.status} without a message.`;
  // Cleared before it is cut, so no half of a secret survives the cut.
  return {
    status: response.status,
    data,
    message: redact(said, secrets).slice(0, 500),
  };
}

/** What happened to a post request, and what that means for running the job again. */
function outcomeOf(answer) {
  const created =
    answer.status === 200
      ? publishResultSchema.safeParse(answer.data)
      : undefined;
  if (created?.success)
    return { outcome: "created", postId: created.data.postId };
  const refused = answer.status >= 300 && answer.status < 500;
  const outcome =
    answer.status === 409 ? "already-sent" : refused ? "refused" : "unknown";
  const advice =
    outcome === "unknown"
      ? " The post may exist: check Buffer. Running the job again cannot create a second one."
      : "";
  return {
    outcome,
    ...(answer.status ? { status: answer.status } : {}),
    message: `${answer.message}${advice}`,
  };
}

/** Uploads the image of a channel, once per file and run, and posts. */
export async function send(entry, images, uploads, context) {
  if (!uploads.has(entry.image))
    uploads.set(
      entry.image,
      await ask(context, {
        method: "POST",
        route: "/api/buffer/media",
        type: "image/png",
        payload: images.get(entry.image),
      }),
    );
  const upload = uploads.get(entry.image);
  const media =
    upload.status === 200 ? uploadSchema.safeParse(upload.data) : undefined;
  if (!media?.success)
    return {
      outcome: "failed",
      ...(upload.status ? { status: upload.status } : {}),
      message: `The image was not uploaded, so nothing was posted: ${upload.message}`,
    };
  return outcomeOf(
    await ask(context, {
      method: "POST",
      route: "/api/buffer/posts",
      type: "application/json",
      payload: JSON.stringify(body(entry, media.data.mediaId)),
    }),
  );
}
