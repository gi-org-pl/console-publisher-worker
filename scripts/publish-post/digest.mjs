import { createHash } from "node:crypto";

// Fingerprints: of an image, and of everything a channel is about to get.

/** @param {Uint8Array | string} value */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Ties a channel's state to what was prepared for it, so a job edited after a
 * post was created is noticed instead of being reported as already published.
 * @param {{ mode: string, dueAt?: string, text: string, imageSha256: string }} content
 */
export function contentDigest({ mode, dueAt, text, imageSha256 }) {
  return sha256(JSON.stringify([mode, dueAt ?? null, text, imageSha256]));
}
