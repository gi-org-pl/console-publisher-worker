// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contentDigest, sha256 } from "./digest.mjs";

function png(width = 1080, height = 1350, length = 24) {
  const bytes = new Uint8Array(length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("contentDigest", () => {
  const content = {
    mode: "customScheduled",
    dueAt: "2026-10-20T07:00:00.000Z",
    text: "Hello",
    imageSha256: sha256(png()),
  };

  describe("when nothing changed", () => {
    it("is the same", () => {
      expect(contentDigest({ ...content })).toBe(contentDigest(content));
      expect(contentDigest(content)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("when anything that is sent changed", () => {
    it.each([
      [{ mode: "addToQueue" }],
      [{ dueAt: "2026-10-20T08:00:00.000Z" }],
      [{ dueAt: undefined }],
      [{ text: "Hello!" }],
      [{ imageSha256: sha256(png(1080, 1080)) }],
    ])("differs for %j", (change) => {
      expect(contentDigest({ ...content, ...change })).not.toBe(
        contentDigest(content),
      );
    });
  });
});
