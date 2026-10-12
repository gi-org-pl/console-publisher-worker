// @vitest-environment node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferFetch,
  bufferPosts,
  client,
  count,
  dir,
  env,
  inMinutes,
  instagram,
  linkedin,
  origin,
  outcomes,
  png,
  readState,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("queue", () => {
  describe("when --send is not given", () => {
    it("validates, checks the session and sends no upload and no post", async () => {
      await writeFile(path.join(dir, "portrait.png"), png(1080, 1350));
      await writeFile(
        path.join(dir, "instagram.txt"),
        "﻿  For Instagram\r\nsecond line \r\n",
      );
      const job = await writeJob({
        text: " Hello\r\nfrom the job ",
        channelTextFile: { instagram: "instagram.txt" },
        channelImage: { ig1: "portrait.png" },
      });

      const { exitCode, document, logs } = await client(["queue", job]);
      expect(exitCode).toBe(0);
      const state = await readState();
      expect(document).toEqual({
        ok: true,
        command: "queue",
        sent: false,
        url: origin,
        identity: { service: "gieniek-bot" },
        mode: "addToQueue",
        state: path.join(dir, "post.state.json"),
        channels: [
          {
            ...linkedin,
            requestId: state.channels.li1.requestId,
            outcome: "would-send",
            text: "Hello\nfrom the job",
            image: path.join(dir, "post.png"),
          },
          {
            ...instagram,
            requestId: state.channels.ig1.requestId,
            outcome: "would-send",
            text: "For Instagram\nsecond line",
            image: path.join(dir, "portrait.png"),
          },
        ],
        errors: [],
      });
      expect(state.channels.li1.step).toBe("prepared");
      expect(logs).toEqual([
        "session: 200",
        "dry run: nothing was sent; pass --send to send",
      ]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(bufferFetch).not.toHaveBeenCalled();
    });

    it("keeps the request IDs for the run that sends", async () => {
      const job = await writeJob();
      const dry = await client(["queue", job]);
      const sent = await client(["queue", job, "--send"]);
      expect(
        sent.document.channels.map((channel) => channel.requestId),
      ).toEqual(dry.document.channels.map((channel) => channel.requestId));
      expect(outcomes(sent.document.channels)).toEqual({
        li1: "created",
        ig1: "created",
      });
    });
  });

  describe("when --send is given", () => {
    it("gives each channel one upload and one post", async () => {
      await writeFile(path.join(dir, "portrait.png"), png(1080, 1350));
      const job = await writeJob({
        channelText: { instagram: "For Instagram" },
        channelImage: { instagram: "portrait.png" },
      });

      const { exitCode, document, logs } = await client([
        "queue",
        job,
        "--send",
      ]);
      expect(exitCode).toBe(0);
      expect(document).toMatchObject({ ok: true, sent: true, errors: [] });
      expect(
        document.channels.map(({ id, outcome, postId }) => ({
          id,
          outcome,
          postId,
        })),
      ).toEqual([
        { id: "li1", outcome: "created", postId: "post1" },
        { id: "ig1", outcome: "created", postId: "post2" },
      ]);
      expect(count()).toEqual({ session: 1, media: 2, posts: 2 });
      expect(logs).toEqual([
        "session: 200",
        "linkedin (li1): upload 200",
        "linkedin (li1): post 200",
        "instagram (ig1): upload 200",
        "instagram (ig1): post 200",
      ]);

      const uploads = seen.filter(
        (request) => request.path === "/api/buffer/media",
      );
      expect(uploads.map((request) => request.headers["content-type"])).toEqual(
        ["image/png", "image/png"],
      );
      expect(uploads[1].body.equals(Buffer.from(png(1080, 1350)))).toBe(true);

      const state = await readState();
      expect(state.channels.li1).toMatchObject({
        step: "created",
        postId: "post1",
        service: "linkedin",
      });
      expect(bufferPosts()).toEqual([
        expect.objectContaining({
          channelId: "li1",
          text: "Hello from the job",
          mode: "addToQueue",
          assets: [
            {
              image: {
                url: `${origin}/buffer-media/${state.channels.li1.mediaId}.png`,
              },
            },
          ],
        }),
        expect.objectContaining({
          channelId: "ig1",
          text: "For Instagram",
          mode: "addToQueue",
          metadata: { instagram: { type: "post", shouldShareToFeed: true } },
        }),
      ]);
      expect(bufferPosts()[0]).not.toHaveProperty("dueAt");
    });

    it("sends nothing new on a second run and reports the same posts", async () => {
      const job = await writeJob();
      const first = await client(["queue", job, "--send"]);
      seen.length = 0;

      const second = await client(["queue", job, "--send"]);
      expect(second.exitCode).toBe(0);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
      expect(outcomes(second.document.channels)).toEqual({
        li1: "already-created",
        ig1: "already-created",
      });
      expect(second.document.channels.map((channel) => channel.postId)).toEqual(
        first.document.channels.map((channel) => channel.postId),
      );
      expect(second.logs).toEqual(["session: 200"]);

      const dry = await client(["queue", job]);
      expect(dry.exitCode).toBe(0);
      expect(outcomes(dry.document.channels)).toEqual({
        li1: "already-created",
        ig1: "already-created",
      });
    });

    it("posts only to the channels the job names", async () => {
      const job = await writeJob({
        channels: ["instagram"],
        channelImage: { instagram: "./post.png" },
      });
      const { document } = await client([
        "queue",
        job,
        "--send",
        "--state",
        "elsewhere.json",
      ]);
      expect(document.state).toBe(path.join(dir, "elsewhere.json"));
      expect(outcomes(document.channels)).toEqual({ ig1: "created" });
      expect(count()).toEqual({ session: 1, media: 1, posts: 1 });
      expect(Object.keys((await readState("elsewhere.json")).channels)).toEqual(
        ["ig1"],
      );
    });
  });

  describe("when the Worker refuses one channel", () => {
    it("reports its message, still sends the others and exits with 1", async () => {
      const job = await writeJob();
      // LinkedIn leaves the allowlist after the session listed it.
      standIn.afterAnswer = (request) => {
        if (request.path === "/api/buffer/session")
          env.CHANNELS_JSON = JSON.stringify([instagram]);
      };

      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(1);
      expect(first.document.ok).toBe(false);
      expect(first.document.errors).toEqual([]);
      expect(first.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "refused",
          status: 403,
          message: "This channel is not allowed.",
        }),
        expect.objectContaining({
          id: "ig1",
          outcome: "created",
          postId: "post1",
        }),
      ]);
      expect((await readState()).channels.li1).toMatchObject({
        step: "refused",
        status: 403,
        message: "This channel is not allowed.",
      });

      // Allowed again: the refused channel goes out with its request ID.
      standIn.afterAnswer = () => {};
      env.CHANNELS_JSON = JSON.stringify([linkedin, instagram]);
      seen.length = 0;
      const second = await client(["queue", job, "--send"]);
      expect(second.exitCode).toBe(0);
      expect(second.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          requestId: first.document.channels[0].requestId,
          outcome: "created",
          postId: "post2",
        }),
        expect.objectContaining({
          id: "ig1",
          outcome: "already-created",
          postId: "post1",
        }),
      ]);
      expect(count()).toEqual({ session: 1, media: 1, posts: 1 });
    });
  });

  describe("when the job is wrong", () => {
    it.each([
      [{ dueAt: inMinutes(180) }, /^queue takes no "dueAt"/],
      [{ textFile: "post.txt" }, /^Give either "text" or "textFile"\.$/],
      [{ text: undefined, textFile: "missing.txt" }, /^Cannot read textFile /],
      [{ text: "   " }, /^text: Too small/],
      [{ image: "missing.png" }, /^Cannot read image .*ENOENT$/],
      [
        { channelText: { linkedin: "x".repeat(5001) } },
        /^channelText\.linkedin: Too big/,
      ],
      [
        { channelTextFile: { linkedin: "missing.txt" } },
        /^Cannot read channelTextFile\.linkedin /,
      ],
      [
        { channelImage: { linkedin: "post.json" } },
        /^channelImage\.linkedin: not a PNG file\.$/,
      ],
    ])("stops at %j before any request", async (change, message) => {
      const job = await writeJob(change);
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toHaveLength(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(document.errors[0].message).toMatch(message);
      expect(document.channels).toEqual([]);
      expect(seen).toHaveLength(0);
    });

    describe("with a file that is not UTF-8", () => {
      // "Zażółć" as Windows-1250 writes it.
      const legacy = Buffer.from([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]);

      it.each([
        ["the job", "post.json", {}],
        ["textFile", "post.txt", { text: undefined, textFile: "post.txt" }],
        [
          "channelTextFile.linkedin",
          "linkedin.txt",
          { channelTextFile: { linkedin: "linkedin.txt" } },
        ],
      ])("stops at %s before any request", async (label, file, change) => {
        const job = await writeJob(change);
        await writeFile(
          path.join(dir, file),
          file === job
            ? Buffer.concat([
                Buffer.from('{"image":"post.png","text":"'),
                legacy,
                Buffer.from('"}'),
              ])
            : legacy,
        );

        const { exitCode, document } = await client(["queue", job, "--send"]);
        expect(exitCode).toBe(1);
        expect(document.errors).toHaveLength(1);
        expect(document.errors[0].code).toBe("invalid-job");
        expect(document.errors[0].message).toMatch(
          new RegExp(`^Cannot read ${label} .*: the file is not valid UTF-8$`),
        );
        expect(document.channels).toEqual([]);
        expect(seen).toHaveLength(0);
      });

      it("sends a UTF-8 text file as it is, without its byte order mark", async () => {
        const job = await writeJob({ text: undefined, textFile: "post.txt" });
        await writeFile(
          path.join(dir, "post.txt"),
          "\uFEFFZażółć gęślą jaźń\r\n",
        );

        const { exitCode } = await client(["queue", job, "--send"]);
        expect(exitCode).toBe(0);
        expect(bufferPosts().at(-1).text).toBe("Zażółć gęślą jaźń");
      });
    });

    it("reports a job file that does not exist", async () => {
      const { document } = await client(["queue", "missing.json", "--send"]);
      expect(document.errors[0]).toMatchObject({ code: "invalid-job" });
      expect(document.errors[0].message).toMatch(
        /^Cannot read the job .*ENOENT$/,
      );
      expect(seen).toHaveLength(0);
    });

    it("sends nothing when a name matches no channel of the session", async () => {
      const job = await writeJob({
        channels: ["linkedin", "threads"],
        channelText: { instagram: "For Instagram" },
      });
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "unknown-channel",
          message:
            'channels: "threads" is not a channel of this session; channelText: "instagram" matches no selected channel. The session has: linkedin (li1), instagram (ig1).',
        },
      ]);
      expect(document.identity).toEqual({ service: "gieniek-bot" });
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });
  });
});
