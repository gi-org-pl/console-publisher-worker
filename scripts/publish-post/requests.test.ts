// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  publishInputSchema,
  SERVICE_MODES,
} from "../../src/schemas/publishing";
import { MODES } from "./arguments.mjs";
import { CHECK_BUFFER } from "./errors.mjs";
import {
  buildPostRequest,
  buildSessionRequest,
  buildUploadRequest,
  classifyPost,
  isRefusal,
} from "./requests.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};

const requestId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df";
const mediaId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5de";

function png(width = 1080, height = 1350, length = 24) {
  const bytes = new Uint8Array(length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("the requests", () => {
  const headers = {
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  };
  const input = {
    requestId,
    mediaId,
    channelId: "li1",
    text: "Hello",
    mode: MODES.queue,
  };

  describe("when the session is asked for", () => {
    it("sends the two Access headers and nothing else", () => {
      expect(buildSessionRequest(credentials)).toEqual({
        method: "GET",
        path: "/api/buffer/session",
        headers,
      });
    });
  });

  describe("when an image is uploaded", () => {
    it("sends the bytes as image/png", () => {
      const bytes = png();
      expect(buildUploadRequest(credentials, bytes)).toEqual({
        method: "POST",
        path: "/api/buffer/media",
        headers: { ...headers, "Content-Type": "image/png" },
        body: bytes,
      });
    });
  });

  describe("when a post is queued or scheduled", () => {
    it("sends exactly the fields of the Worker's schema", () => {
      const request = buildPostRequest(credentials, input);
      expect(request).toMatchObject({
        method: "POST",
        path: "/api/buffer/posts",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      expect(JSON.parse(request.body)).toEqual(input);
      expect(publishInputSchema.parse(JSON.parse(request.body))).toEqual(input);
    });

    it("adds the time of a scheduled post", () => {
      const scheduled = {
        ...input,
        mode: MODES.schedule,
        dueAt: "2026-10-20T07:00:00.000Z",
      };
      expect(JSON.parse(buildPostRequest(credentials, scheduled).body)).toEqual(
        scheduled,
      );
    });

    it("never sends an Origin header", () => {
      for (const request of [
        buildSessionRequest(credentials),
        buildUploadRequest(credentials, png()),
        buildPostRequest(credentials, input),
      ])
        expect(
          Object.keys(request.headers).map((name) => name.toLowerCase()),
        ).not.toContain("origin");
    });
  });

  describe("when the request would not pass the Worker", () => {
    it.each([
      [{ mode: "shareNow" }, /^Mode shareNow is not offered\.$/],
      [{ requestId: "1" }, /does not match the Worker's schema: requestId: /],
      [{ text: "" }, /does not match the Worker's schema: text: /],
      [{ extra: true }, /does not match the Worker's schema: : Unrecognized/],
    ])("refuses to build %j", (change, message) => {
      expect(() =>
        buildPostRequest(credentials, { ...input, ...change }),
      ).toThrow(message);
    });
  });

  describe("when the modes are compared with the Worker's", () => {
    it("offers a service exactly the modes it may use", () => {
      expect(Object.values(MODES).sort()).toEqual([...SERVICE_MODES].sort());
      expect(Object.keys(MODES)).toEqual(["queue", "schedule"]);
    });
  });
});

describe("isRefusal and classifyPost", () => {
  describe("when the Worker created the post", () => {
    it("reports the post ID", () => {
      expect(
        classifyPost({ status: 200, data: { postId: "p1" }, message: "" }),
      ).toEqual({ outcome: "created", postId: "p1" });
    });
  });

  describe("when the Worker or Access turned the request down", () => {
    it.each([
      302, 400, 401, 403, 404, 405, 413, 415, 429,
    ])("reports %i as refused with the message", (status) => {
      expect(isRefusal(status)).toBe(true);
      expect(
        classifyPost({ status, data: { message: "No." }, message: "No." }),
      ).toEqual({ outcome: "refused", status, message: "No." });
    });
  });

  describe("when nothing says whether a post exists", () => {
    it.each([
      0, 200, 204, 409, 500, 502, 503,
    ])("reports %i as unknown and points to Buffer", (status) => {
      expect(isRefusal(status)).toBe(false);
      const result = classifyPost({ status, data: {}, message: "Hm." });
      expect(result).toMatchObject({ outcome: "unknown", status });
      expect((result as { message: string }).message).toContain(CHECK_BUFFER);
    });
  });
});
