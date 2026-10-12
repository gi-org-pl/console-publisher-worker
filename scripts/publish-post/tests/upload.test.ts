// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  client,
  count,
  localFetch,
  origin,
  outcomes,
  readState,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("an upload that fails", () => {
  describe("when the Worker refuses the image", () => {
    it("reports it, sends no post for that channel and uploads again next time", async () => {
      const job = await writeJob();
      let uploads = 0;
      standIn.answer = (request) =>
        request.path === "/api/buffer/media" && ++uploads === 1
          ? Response.json(
              { message: "The image must be at most 5 MB." },
              { status: 413 },
            )
          : undefined;

      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(1);
      expect(first.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "refused",
          status: 413,
          message: "Upload: The image must be at most 5 MB.",
        }),
        expect.objectContaining({ id: "ig1", outcome: "created" }),
      ]);
      expect(count()).toEqual({ session: 1, media: 2, posts: 1 });
      expect((await readState()).channels.li1).not.toHaveProperty("mediaId");

      const second = await client(["queue", job, "--send"]);
      expect(second.exitCode).toBe(0);
      expect(outcomes(second.document.channels)).toEqual({
        li1: "created",
        ig1: "already-created",
      });
    });
  });

  describe("when the upload has no usable answer", () => {
    it.each([
      [
        Response.json(
          { message: "Publishing is not configured yet." },
          { status: 503 },
        ),
        { status: 503, message: "Upload: Publishing is not configured yet." },
      ],
      [
        Response.json({}),
        {
          status: 200,
          message: "Upload: the Worker answered without a media ID.",
        },
      ],
    ])("reports the channel as failed and sends no post", async (response, expected) => {
      const job = await writeJob({ channels: ["linkedin"] });
      standIn.answer = (request) =>
        request.path === "/api/buffer/media" ? response : undefined;
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.channels[0]).toMatchObject({
        outcome: "failed",
        ...expected,
      });
      expect(count().posts).toBe(0);
      expect((await readState()).channels.li1).toMatchObject({
        step: "failed",
        ...expected,
      });
    });

    it("reports a connection that broke and tries again next time", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const first = await client(["queue", job, "--send"], {
        fetch: async (input: URL, init: RequestInit) => {
          if (input.pathname === "/api/buffer/media")
            throw new TypeError("fetch failed");
          return localFetch(input, init);
        },
      });
      expect(first.document.channels[0]).toMatchObject({
        outcome: "failed",
        message: `Upload: No answer from ${origin}: fetch failed.`,
      });
      expect(first.document.channels[0]).not.toHaveProperty("status");

      const second = await client(["queue", job, "--send"]);
      expect(second.exitCode).toBe(0);
      expect(second.document.channels[0].requestId).toBe(
        first.document.channels[0].requestId,
      );
    });
  });
});
