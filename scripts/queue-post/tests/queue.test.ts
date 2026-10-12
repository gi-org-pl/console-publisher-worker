// @vitest-environment node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferFetch,
  bufferPosts,
  type Channel,
  count,
  dir,
  instagram,
  linkedin,
  outcomes,
  png,
  script,
  seen,
  standIn,
  useWorkerStandIn,
  viaWorker,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("preview", () => {
  describe("when the job is valid", () => {
    it("prints what each channel would get and sends only the session request", async () => {
      const job = await writeJob();
      const { exitCode, document } = await script(["preview", job]);
      expect(exitCode).toBe(0);
      expect(document).toMatchObject({
        ok: true,
        command: "preview",
        name: "autumn-news",
      });
      expect(document.channels).toEqual([
        {
          ...linkedin,
          requestId: expect.any(String),
          outcome: "would-send",
          text: "Hello from the job",
          image: "post.png",
        },
        {
          ...instagram,
          requestId: expect.any(String),
          outcome: "would-send",
          text: "Hello from the job",
          image: "post.png",
        },
      ]);
      expect(seen).toHaveLength(1);
      expect(bufferFetch).not.toHaveBeenCalled();
    });

    it("prints the request IDs a later queue uses", async () => {
      const job = await writeJob();
      const preview = await script(["preview", job]);
      const queue = await script(["queue", job]);
      expect(
        queue.document.channels.map((channel: Channel) => channel.requestId),
      ).toEqual(
        preview.document.channels.map((channel: Channel) => channel.requestId),
      );
    });
  });
});

describe("queue", () => {
  describe("when the job names no channels", () => {
    it("creates one queued post per channel of the session, with one upload", async () => {
      const job = await writeJob();
      const { exitCode, document } = await script(["queue", job]);
      expect(exitCode).toBe(0);
      expect(document.ok).toBe(true);
      expect(document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "created",
          postId: "post1",
        }),
        expect.objectContaining({
          id: "ig1",
          outcome: "created",
          postId: "post2",
        }),
      ]);
      expect(count("media")).toBe(1);
      expect(count("posts")).toBe(2);
      expect(bufferPosts()).toEqual([
        expect.objectContaining({
          channelId: "li1",
          text: "Hello from the job",
          mode: "addToQueue",
        }),
        expect.objectContaining({
          channelId: "ig1",
          text: "Hello from the job",
          mode: "addToQueue",
        }),
      ]);
    });
  });

  describe("when the job selects channels and gives one its own text and image", () => {
    it("sends each channel what the job says, an ID before a network", async () => {
      await writeFile(path.join(dir, "post-tall.png"), png(32));
      const job = await writeJob({
        channels: ["linkedin", "ig1"],
        overrides: {
          instagram: { text: "For the network", image: "post-tall.png" },
          ig1: { text: "For this channel" },
        },
      });
      const { document } = await script(["queue", job]);
      expect(document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          text: "Hello from the job",
          image: "post.png",
          outcome: "created",
        }),
        expect.objectContaining({
          id: "ig1",
          text: "For this channel",
          image: "post-tall.png",
          outcome: "created",
        }),
      ]);
      expect(count("media")).toBe(2);
      expect(bufferPosts().map((post) => post.text)).toEqual([
        "Hello from the job",
        "For this channel",
      ]);
    });

    it("leaves the other channels alone", async () => {
      const job = await writeJob({ channels: ["li1"] });
      const { document } = await script(["queue", job]);
      expect(outcomes(document.channels)).toEqual({ li1: "created" });
      expect(bufferFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the same job is run again", () => {
    it("creates no second post: the Worker knows the request IDs", async () => {
      const job = await writeJob();
      await script(["queue", job]);
      const again = await script(["queue", job]);
      expect(again.exitCode).toBe(1);
      expect(again.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "already-sent",
          status: 409,
          message:
            "This request was already sent. Check Buffer before creating another post.",
        }),
        expect.objectContaining({
          id: "ig1",
          outcome: "already-sent",
          status: 409,
        }),
      ]);
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });

    it("creates none for a changed text under the same name either", async () => {
      await script(["queue", await writeJob()]);
      const changed = await script([
        "queue",
        await writeJob({ text: "Another text" }),
      ]);
      expect(outcomes(changed.document.channels)).toEqual({
        li1: "already-sent",
        ig1: "already-sent",
      });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });

    it("creates the post of a channel that failed the first time, and only that one", async () => {
      const job = await writeJob();
      bufferFetch.mockImplementationOnce(async () =>
        Response.json({ data: { createPost: { post: { id: "post1" } } } }),
      );
      standIn.answer = (request) =>
        request.path === "/api/buffer/posts" && count("posts") === 2
          ? Response.json(
              { message: "This channel is not allowed." },
              { status: 403 },
            )
          : undefined;
      const first = await script(["queue", job]);
      expect(outcomes(first.document.channels)).toEqual({
        li1: "created",
        ig1: "refused",
      });

      standIn.answer = () => undefined;
      const second = await script(["queue", job]);
      expect(outcomes(second.document.channels)).toEqual({
        li1: "already-sent",
        ig1: "created",
      });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("when another post has another name", () => {
    it("gets request IDs of its own", async () => {
      const first = await script(["preview", await writeJob()]);
      const second = await script([
        "preview",
        await writeJob({ name: "winter-news" }),
      ]);
      const ids = [...first.document.channels, ...second.document.channels].map(
        (channel: Channel) => channel.requestId,
      );
      expect(new Set(ids).size).toBe(4);
      for (const id of ids)
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    });
  });

  describe("when a post request has no usable answer", () => {
    it.each([
      [
        () =>
          Response.json({ message: "Buffer did not answer." }, { status: 502 }),
        { status: 502 },
        "Buffer did not answer.",
      ],
      [
        () => Response.json({}),
        { status: 200 },
        "The Console answered 200 without a message.",
      ],
    ])("reports the channel as unknown and says what to do", async (response, status, said) => {
      const job = await writeJob({ channels: ["li1"] });
      standIn.answer = (request) =>
        request.path === "/api/buffer/posts" ? response() : undefined;
      const { exitCode, document } = await script(["queue", job]);
      expect(exitCode).toBe(1);
      expect(document.channels[0]).toMatchObject({
        outcome: "unknown",
        ...status,
        message: `${said} The post may exist: check Buffer. Running the job again cannot create a second one.`,
      });
    });

    it("reports a connection that broke the same way, without a status", async () => {
      const job = await writeJob({ channels: ["li1"] });
      const { document } = await script(["queue", job], {
        fetch: (async (input, init) => {
          if (String(input).endsWith("/posts"))
            throw new TypeError("fetch failed");
          return viaWorker(input, init);
        }) as typeof fetch,
      });
      expect(document.channels[0].outcome).toBe("unknown");
      expect(document.channels[0]).not.toHaveProperty("status");
    });
  });

  describe("when the upload fails", () => {
    it("posts nothing for the channels of that image", async () => {
      const job = await writeJob();
      standIn.answer = (request) =>
        request.path === "/api/buffer/media"
          ? Response.json(
              { message: "The image is too large." },
              { status: 413 },
            )
          : undefined;
      const { exitCode, document } = await script(["queue", job]);
      expect(exitCode).toBe(1);
      expect(document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "failed",
          status: 413,
          message:
            "The image was not uploaded, so nothing was posted: The image is too large.",
        }),
        expect.objectContaining({ id: "ig1", outcome: "failed", status: 413 }),
      ]);
      expect(count("media")).toBe(1);
      expect(count("posts")).toBe(0);
    });
  });
});
