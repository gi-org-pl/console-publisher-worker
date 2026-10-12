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
  outcomes,
  readState,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("schedule", () => {
  describe("when the job has a time far enough ahead", () => {
    it("schedules each channel at that time, in UTC", async () => {
      const dueAt = inMinutes(180);
      const job = await writeJob({ dueAt });
      const { exitCode, document } = await client(["schedule", job, "--send"]);
      expect(exitCode).toBe(0);
      expect(document.mode).toBe("customScheduled");
      expect(document.dueAt).toBe(new Date(dueAt).toISOString());
      expect(outcomes(document.channels)).toEqual({
        li1: "created",
        ig1: "created",
      });
      expect(
        bufferPosts().map(({ mode, dueAt: due }) => ({ mode, dueAt: due })),
      ).toEqual([
        { mode: "customScheduled", dueAt: new Date(dueAt).toISOString() },
        { mode: "customScheduled", dueAt: new Date(dueAt).toISOString() },
      ]);
    });
  });

  describe("when the job is run again after its time has passed", () => {
    const later = (dueAt: string) => () => Date.parse(dueAt) + 60_000;

    it("still reports the posts that were scheduled", async () => {
      const dueAt = inMinutes(180);
      const job = await writeJob({ dueAt });
      const first = await client(["schedule", job, "--send"]);
      expect(first.exitCode).toBe(0);
      seen.length = 0;

      const second = await client(["schedule", job, "--send"], {
        now: later(dueAt),
      });
      expect(second.exitCode).toBe(0);
      expect(second.document.errors).toEqual([]);
      expect(
        second.document.channels.map(({ outcome, postId }) => ({
          outcome,
          postId,
        })),
      ).toEqual(
        first.document.channels.map(({ postId }) => ({
          outcome: "already-created",
          postId,
        })),
      );
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("still reports a post whose result is unknown", async () => {
      const dueAt = inMinutes(180);
      const job = await writeJob({ dueAt, channels: ["linkedin"] });
      await client(["schedule", job]);
      const state = await readState();
      state.channels.li1.step = "posting";
      await writeFile(path.join(dir, "post.state.json"), JSON.stringify(state));

      const { exitCode, document } = await client(["schedule", job, "--send"], {
        now: later(dueAt),
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([]);
      expect(document.channels[0].outcome).toBe("unknown");
    });

    it.each([
      [["schedule", "--send"]],
      [["schedule"]],
    ])("sends nothing to a channel that is still open (%j)", async ([
      command,
      ...flags
    ]) => {
      const dueAt = inMinutes(180);
      const job = await writeJob({ dueAt });
      await client(["schedule", job]);
      seen.length = 0;

      const { exitCode, document } = await client([command, job, ...flags], {
        now: later(dueAt),
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([]);
      expect(document.channels).toHaveLength(2);
      for (const channel of document.channels) {
        expect(channel.outcome).toBe("failed");
        expect(channel.message).toMatch(
          /^dueAt: .* is not in the future\. This channel was not sent\.$/,
        );
      }
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("reports the channel that is done and holds back the one that is not", async () => {
      const dueAt = inMinutes(180);
      const job = await writeJob({ dueAt });
      // LinkedIn leaves the allowlist after the session listed it, so the
      // first run creates the post of Instagram only.
      standIn.afterAnswer = (request) => {
        if (request.path === "/api/buffer/session")
          env.CHANNELS_JSON = JSON.stringify([instagram]);
      };
      const first = await client(["schedule", job, "--send"]);
      expect(outcomes(first.document.channels)).toEqual({
        li1: "refused",
        ig1: "created",
      });
      standIn.afterAnswer = () => {};
      env.CHANNELS_JSON = JSON.stringify([linkedin, instagram]);
      seen.length = 0;

      const { exitCode, document } = await client(["schedule", job, "--send"], {
        now: later(dueAt),
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([]);
      expect(document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "failed",
          message: expect.stringMatching(
            /is not in the future\. This channel was not sent\.$/,
          ),
        }),
        expect.objectContaining({
          id: "ig1",
          outcome: "already-created",
          postId: first.document.channels[1].postId,
        }),
      ]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });
  });

  describe("when the time is inside the service's lead time", () => {
    it("reports the Worker's refusal for each channel and can be corrected", async () => {
      const job = await writeJob({ dueAt: inMinutes(10) });
      const first = await client(["schedule", job, "--send"]);
      expect(first.exitCode).toBe(1);
      expect(first.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          outcome: "refused",
          status: 400,
          message: "Choose a time from 120 minutes to 30 days from now.",
        }),
        expect.objectContaining({ id: "ig1", outcome: "refused", status: 400 }),
      ]);
      expect(bufferFetch).not.toHaveBeenCalled();

      // Nothing was created, so the same state file takes the corrected job.
      await writeJob({ dueAt: inMinutes(180) });
      const second = await client(["schedule", job, "--send"]);
      expect(second.exitCode).toBe(0);
      expect(
        second.document.channels.map((channel) => channel.requestId),
      ).toEqual(first.document.channels.map((channel) => channel.requestId));
      expect(outcomes(second.document.channels)).toEqual({
        li1: "created",
        ig1: "created",
      });
    });
  });

  describe("when the time is missing or outside the Worker's window", () => {
    it.each([
      [{}, /^schedule needs "dueAt"/],
      [{ dueAt: "2026-10-20T09:00:00" }, /^dueAt: /],
      [{ dueAt: inMinutes(-5) }, /is not in the future\.$/],
      [{ dueAt: inMinutes(31 * 24 * 60) }, /is more than 30 days from now\.$/],
    ])("stops at %j before any request", async (change, message) => {
      const job = await writeJob(change);
      const { exitCode, document } = await client(["schedule", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(document.errors[0].message).toMatch(message);
      expect(seen).toHaveLength(0);
    });
  });
});
