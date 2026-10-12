// @vitest-environment node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_BUFFER } from "../errors.mjs";
import {
  bufferFetch,
  client,
  count,
  dir,
  localFetch,
  origin,
  readState,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("a post without a known result", () => {
  describe("when Buffer does not confirm it", () => {
    it("is reported as unknown and never sent again by itself", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      bufferFetch.mockRejectedValueOnce(new Error("timeout"));

      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(1);
      expect(first.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "unknown",
          status: 502,
          message: `Buffer did not confirm the post. Check the Buffer queue and history before publishing again. ${CHECK_BUFFER}`,
        }),
      ]);
      expect((await readState()).channels.li1).toMatchObject({
        step: "posting",
        status: 502,
      });

      seen.length = 0;
      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const again = await client(argv);
        expect(again.exitCode).toBe(1);
        expect(again.document.channels[0]).toMatchObject({
          outcome: "unknown",
          status: 502,
          requestId: first.document.channels[0].requestId,
        });
      }
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
      expect(bufferFetch).toHaveBeenCalledTimes(1);

      // A person looked in Buffer, found nothing and cleared the channel.
      const state = await readState();
      delete state.channels.li1;
      await writeFile(path.join(dir, "post.state.json"), JSON.stringify(state));
      const cleared = await client(["queue", job, "--send"]);
      expect(cleared.exitCode).toBe(0);
      expect(cleared.document.channels[0]).toMatchObject({
        outcome: "created",
        postId: "post1",
      });
      expect(cleared.document.channels[0].requestId).not.toBe(
        first.document.channels[0].requestId,
      );
    });
  });

  describe("when the answer breaks off after its first line", () => {
    const brokenBody =
      (status: number) => async (input: URL, init: RequestInit) => {
        const response = await localFetch(input, init);
        if (input.pathname !== "/api/buffer/posts") return response;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("socket hang up"));
            },
          }),
          { status },
        );
      };

    it("reports a post answered with 200 as unknown, never as failed", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const first = await client(["queue", job, "--send"], {
        fetch: brokenBody(200),
      });
      expect(first.exitCode).toBe(1);
      expect(first.document.channels[0]).toMatchObject({
        outcome: "unknown",
        status: 200,
        message: `The Worker answered without a post ID. ${CHECK_BUFFER}`,
      });
      expect((await readState()).channels.li1.step).toBe("posting");

      const second = await client(["queue", job, "--send"]);
      expect(second.document.channels[0].outcome).toBe("unknown");
      expect(count().posts).toBe(1);
    });

    it("reports a post answered with 502 as unknown too", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const { document } = await client(["queue", job, "--send"], {
        fetch: brokenBody(502),
      });
      expect(document.channels[0].outcome).toBe("unknown");
      expect((await readState()).channels.li1.step).toBe("posting");
    });
  });

  describe("when the answer is lost on the way back", () => {
    it("does not create a second post on the next run", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const first = await client(["queue", job, "--send"], {
        fetch: async (input: URL, init: RequestInit) => {
          const response = await localFetch(input, init);
          if (input.pathname === "/api/buffer/posts")
            throw new TypeError("fetch failed", {
              cause: new Error("socket hang up"),
            });
          return response;
        },
      });
      expect(first.exitCode).toBe(1);
      expect(first.document.channels[0]).toMatchObject({
        outcome: "unknown",
        message: `No answer from ${origin}: fetch failed (socket hang up). ${CHECK_BUFFER}`,
      });
      expect(first.document.channels[0]).not.toHaveProperty("status");
      expect(first.logs.at(-1)).toBe("linkedin (li1): post no answer");
      expect((await readState()).channels.li1).not.toHaveProperty("status");

      const second = await client(["queue", job, "--send"]);
      expect(second.document.channels[0].outcome).toBe("unknown");
      expect(bufferFetch).toHaveBeenCalledTimes(1);
      expect(count().posts).toBe(1);
    });
  });

  describe("when a run died after sending the post", () => {
    it("asks for a look in Buffer", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job]);
      const state = await readState();
      state.channels.li1.step = "posting";
      await writeFile(path.join(dir, "post.state.json"), JSON.stringify(state));

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.channels[0]).toMatchObject({
        outcome: "unknown",
        message: `An earlier run sent this post and recorded no result. ${CHECK_BUFFER}`,
      });
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
    });
  });

  describe("when the Worker answers 200 without a post ID or with a conflict", () => {
    it.each([
      [
        Response.json({}),
        200,
        `The Worker answered without a post ID. ${CHECK_BUFFER}`,
      ],
      [
        new Response("gateway", { status: 504 }),
        504,
        `HTTP 504 without a message from the Worker. ${CHECK_BUFFER}`,
      ],
      [
        Response.json(
          {
            message:
              "This request was already sent. Check Buffer before creating another post.",
          },
          { status: 409 },
        ),
        409,
        `This request was already sent. Check Buffer before creating another post. ${CHECK_BUFFER}`,
      ],
    ])("keeps the channel blocked", async (response, status, message) => {
      const job = await writeJob({ channels: ["linkedin"] });
      standIn.answer = (request) =>
        request.path === "/api/buffer/posts" ? response : undefined;
      const { document } = await client(["queue", job, "--send"]);
      expect(document.channels[0]).toMatchObject({
        outcome: "unknown",
        status,
        message,
      });
      expect((await readState()).channels.li1.step).toBe("posting");
    });
  });
});
