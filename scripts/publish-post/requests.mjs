import {
  publishInputSchema,
  publishResultSchema,
} from "../../src/schemas/publishing.ts";
import { MODES } from "./arguments.mjs";
import { CHECK_BUFFER, ClientError } from "./errors.mjs";

/** @typedef {import("./credentials.mjs").Credentials} Credentials */

// The three requests the client sends, and how the answer to a post is read.
// The request contract is the Worker's own schema, imported above.

/**
 * The two headers Access checks. A service sends no `Origin`.
 * @param {Credentials} credentials
 */
function accessHeaders({ clientId, clientSecret }) {
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

/** @param {Credentials} credentials */
export function buildSessionRequest(credentials) {
  return {
    method: "GET",
    path: "/api/buffer/session",
    headers: accessHeaders(credentials),
  };
}

/**
 * @param {Credentials} credentials
 * @param {Uint8Array} bytes the PNG
 */
export function buildUploadRequest(credentials, bytes) {
  return {
    method: "POST",
    path: "/api/buffer/media",
    headers: { ...accessHeaders(credentials), "Content-Type": "image/png" },
    body: bytes,
  };
}

/**
 * The body is checked against the Worker's schema, so a request it would turn
 * down as malformed is never sent.
 * @param {Credentials} credentials
 * @param {{ requestId: string, mediaId: string, channelId: string, text: string, mode: string, dueAt?: string }} input
 */
export function buildPostRequest(credentials, input) {
  if (!Object.values(MODES).includes(input.mode))
    throw new ClientError("unexpected", `Mode ${input.mode} is not offered.`);
  const result = publishInputSchema.safeParse(input);
  if (!result.success)
    throw new ClientError(
      "unexpected",
      `The post request does not match the Worker's schema: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  return {
    method: "POST",
    path: "/api/buffer/posts",
    headers: {
      ...accessHeaders(credentials),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(result.data),
  };
}

/**
 * An answer that settles the matter: the request was turned down and nothing
 * was created. A redirect comes from Access, before the Worker. 409 is not in
 * this group: the Worker has seen the request ID and cannot say what became of it.
 * @param {number} status
 */
export function isRefusal(status) {
  return status >= 300 && status < 500 && status !== 409;
}

/**
 * What the answer to a post request means for the channel.
 * @param {{ status: number, data?: unknown, message: string }} answer
 * @returns {{ outcome: "created", postId: string } | { outcome: "refused" | "unknown", status: number, message: string }}
 */
export function classifyPost(answer) {
  if (answer.status === 200) {
    const result = publishResultSchema.safeParse(answer.data);
    if (result.success)
      return { outcome: "created", postId: result.data.postId };
    return {
      outcome: "unknown",
      status: 200,
      message: `The Worker answered without a post ID. ${CHECK_BUFFER}`,
    };
  }
  if (isRefusal(answer.status))
    return {
      outcome: "refused",
      status: answer.status,
      message: answer.message,
    };
  return {
    outcome: "unknown",
    status: answer.status,
    message: `${answer.message} ${CHECK_BUFFER}`,
  };
}
