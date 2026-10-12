// @vitest-environment node
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_BUFFER } from "../errors.mjs";
import {
  bufferFetch,
  bufferPosts,
  client,
  clientId,
  clientSecret,
  count,
  dir,
  env,
  instagram,
  linkedin,
  localFetch,
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

describe("the state file", () => {
  describe("when the job selects a channel it was not first sent to", () => {
    const linkedinTwo = {
      id: "li2",
      name: "Second LinkedIn",
      service: "linkedin",
    };
    const heldBack =
      /^This channel was not among the channels of the job when it was first sent \(li1\)\. It was not sent: a post for it needs a job of its own\.$/;

    it.each([
      ["a job for every channel", {}, instagram],
      ["a job for a network", { channels: ["linkedin"] }, linkedinTwo],
    ])("never sends %s to a channel the session gained later", async (_name, change, gained) => {
      env.CHANNELS_JSON = JSON.stringify([linkedin]);
      const job = await writeJob(change);
      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(0);
      expect((await readState()).targets).toEqual(["li1"]);
      const before = await readFile(path.join(dir, "post.state.json"), "utf8");

      env.CHANNELS_JSON = JSON.stringify([linkedin, gained]);
      seen.length = 0;
      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const again = await client(argv);
        expect(again.exitCode).toBe(1);
        expect(again.document.errors).toEqual([]);
        expect(again.document.channels).toEqual([
          expect.objectContaining({
            id: "li1",
            outcome: "already-created",
            postId: first.document.channels[0].postId,
          }),
          expect.objectContaining({
            id: gained.id,
            outcome: "failed",
            message: expect.stringMatching(heldBack),
          }),
        ]);
        expect(again.document.channels[1]).not.toHaveProperty("requestId");
      }
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
      expect(bufferFetch).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(dir, "post.state.json"), "utf8")).toBe(
        before,
      );
    });

    it("holds back a channel that was added to the job after a send", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job, "--send"]);
      await writeJob();
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(outcomes(document.channels)).toEqual({
        li1: "already-created",
        ig1: "failed",
      });
      expect(document.channels[1].message).toMatch(heldBack);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("still retries a channel of the first send next to one that is held back", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      // LinkedIn is refused the first time.
      standIn.afterAnswer = (request) => {
        if (request.path === "/api/buffer/session")
          env.CHANNELS_JSON = JSON.stringify([instagram]);
      };
      const first = await client(["queue", job, "--send"]);
      expect(outcomes(first.document.channels)).toEqual({ li1: "refused" });
      standIn.afterAnswer = () => {};
      env.CHANNELS_JSON = JSON.stringify([linkedin, linkedinTwo]);
      seen.length = 0;

      const second = await client(["queue", job, "--send"]);
      expect(second.exitCode).toBe(1);
      expect(second.document.channels).toEqual([
        expect.objectContaining({
          id: "li1",
          requestId: first.document.channels[0].requestId,
          outcome: "created",
        }),
        expect.objectContaining({ id: "li2", outcome: "failed" }),
      ]);
      expect(count()).toEqual({ session: 1, media: 1, posts: 1 });
      const state = await readState();
      expect(state.targets).toEqual(["li1"]);
      expect(Object.keys(state.channels)).toEqual(["li1"]);
    });

    it("fixes the channels at the first run that sends, not at a dry run", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const dry = await client(["queue", job]);
      expect(outcomes(dry.document.channels)).toEqual({ li1: "would-send" });
      expect((await readState()).targets).toBeNull();

      // The job is widened before anything went out.
      await writeJob();
      const sent = await client(["queue", job, "--send"]);
      expect(sent.exitCode).toBe(0);
      expect(outcomes(sent.document.channels)).toEqual({
        li1: "created",
        ig1: "created",
      });
      expect(sent.document.channels[0].requestId).toBe(
        dry.document.channels[0].requestId,
      );
      expect((await readState()).targets).toEqual(["li1", "ig1"]);
    });
  });

  describe("when a run stopped between the upload and the post", () => {
    it("posts with the image that is already there", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job]);
      const upload = await localFetch(`${origin}/api/buffer/media`, {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "Content-Type": "image/png",
        },
        body: png(),
      });
      const { mediaId } = (await upload.json()) as { mediaId: string };
      const state = await readState();
      Object.assign(state.channels.li1, { step: "uploaded", mediaId });
      await writeFile(path.join(dir, "post.state.json"), JSON.stringify(state));
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(0);
      expect(document.channels[0].outcome).toBe("created");
      expect(count()).toEqual({ session: 1, media: 0, posts: 1 });
      expect(JSON.parse(seen[1].body.toString())).toMatchObject({ mediaId });
    });
  });

  describe("when the job changed while the result of its post is unknown", () => {
    it("refuses to report the old request as this job's and sends nothing", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job]);
      const state = await readState();
      state.channels.li1.step = "posting";
      const statePath = path.join(dir, "post.state.json");
      await writeFile(statePath, JSON.stringify(state));
      const before = await readFile(statePath, "utf8");
      await writeJob({ channels: ["linkedin"], text: "Another text" });
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "state-mismatch",
          message: `The job changed after a post for linkedin (li1) was sent with no recorded result: what may be in Buffer is the earlier content. ${CHECK_BUFFER} A new post needs a new state file (--state).`,
        },
      ]);
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(await readFile(statePath, "utf8")).toBe(before);
    });
  });

  describe("when the job changed after its post was created", () => {
    it("refuses to report the old post as this job's and sends nothing", async () => {
      const job = await writeJob();
      await client(["queue", job, "--send"]);
      await writeJob({ text: "Another text" });
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "state-mismatch",
          message:
            "The job changed after a post was created for linkedin (li1), instagram (ig1). A new post needs a new state file (--state).",
        },
      ]);
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });

      const fresh = await client([
        "queue",
        job,
        "--send",
        "--state",
        "second.json",
      ]);
      expect(fresh.exitCode).toBe(0);
      expect(bufferPosts().at(-1).text).toBe("Another text");
    });
  });

  describe("when the file cannot be used", () => {
    it("never replaces a file that is not a state", async () => {
      const job = await writeJob();
      await writeFile(path.join(dir, "post.state.json"), "{ not a state");
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("invalid-state");
      expect(document.errors[0].message).toMatch(
        /^The state file is not valid JSON/,
      );
      expect(seen).toHaveLength(0);
      expect(await readFile(path.join(dir, "post.state.json"), "utf8")).toBe(
        "{ not a state",
      );
    });

    it("never reads a state that is not UTF-8 as if it were", async () => {
      const job = await writeJob();
      const statePath = path.join(dir, "post.state.json");
      await client(["queue", job]);
      const broken = Buffer.concat([
        await readFile(statePath),
        Buffer.from([0xbf]),
      ]);
      await writeFile(statePath, broken);
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("invalid-state");
      expect(document.errors[0].message).toMatch(
        /^Cannot read the state file .*: the file is not valid UTF-8$/,
      );
      expect(seen).toHaveLength(0);
      expect(await readFile(statePath)).toEqual(broken);
    });

    it("reports a state that cannot be read", async () => {
      const job = await writeJob();
      await mkdir(path.join(dir, "post.state.json"));
      const { document } = await client(["queue", job, "--send"]);
      expect(document.errors[0].code).toBe("invalid-state");
      expect(document.errors[0].message).toMatch(
        /^Cannot read the state file /,
      );
      expect(seen).toHaveLength(0);
    });

    it("sends nothing when the state cannot be written", async () => {
      const job = await writeJob();
      const { exitCode, document } = await client([
        "queue",
        job,
        "--send",
        "--state",
        "missing/run.json",
      ]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("state-failed");
      expect(document.errors[0].message).toMatch(
        /^Cannot write the state file .*ENOENT\.$/,
      );
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("does not overwrite a state another run has just created", async () => {
      const job = await writeJob();
      const statePath = path.join(dir, "post.state.json");
      const { document } = await client(["queue", job, "--send"], {
        fs: {
          readFile,
          writeFile: async (file: string, data: string, options: object) => {
            await writeFile(statePath, "written by the other run");
            return writeFile(file, data, options);
          },
        },
      });
      expect(document.errors).toEqual([
        {
          code: "state-failed",
          message: `Another run created the state file (${statePath}) in the meantime. Run again.`,
        },
      ]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(await readFile(statePath, "utf8")).toBe(
        "written by the other run",
      );
    });
  });

  describe("when the state was made against another address", () => {
    it("records the address of the Worker in the state", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job]);
      expect(
        JSON.parse(await readFile(path.join(dir, "post.state.json"), "utf8"))
          .origin,
      ).toBe(origin);
    });

    it("sends nothing and leaves the state as it is", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job, "--send"]);
      const statePath = path.join(dir, "post.state.json");
      const elsewhere = JSON.stringify({
        ...JSON.parse(await readFile(statePath, "utf8")),
        origin: "https://console.gi.org.pl",
      });
      await writeFile(statePath, elsewhere);
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "state-mismatch",
          message: `The state file (${statePath}) was made against https://console.gi.org.pl and this run goes to ${origin}. Use another state file (--state).`,
        },
      ]);
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
      expect(await readFile(statePath, "utf8")).toBe(elsewhere);
    });

    it("refuses a state without an address and leaves it as it is", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      await client(["queue", job, "--send"]);
      const statePath = path.join(dir, "post.state.json");
      const { origin: _dropped, ...older } = JSON.parse(
        await readFile(statePath, "utf8"),
      );
      const without = JSON.stringify(older);
      await writeFile(statePath, without);
      seen.length = 0;

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toHaveLength(1);
      expect(document.errors[0].code).toBe("invalid-state");
      expect(document.errors[0].message).toMatch(
        /^The state file is not a state of this client: origin: /,
      );
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
      expect(await readFile(statePath, "utf8")).toBe(without);
    });
  });

  describe("when the session lists a channel whose ID is a name every object inherits", () => {
    it.each([
      "constructor",
      "__proto__",
    ])("sends nothing and writes no state for %s", async (id) => {
      const job = await writeJob();
      env.CHANNELS_JSON = JSON.stringify([{ ...linkedin, id }, instagram]);
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "unusable-channel",
          message: `The session lists a channel whose ID cannot be a key of the state file: ${id}. Nothing is sent until the Worker's channel list is fixed.`,
        },
      ]);
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(await readdir(dir)).not.toContain("post.state.json");
    });
  });

  describe("when the session lists a channel twice", () => {
    it("sends nothing and says so", async () => {
      const job = await writeJob();
      env.CHANNELS_JSON = JSON.stringify([linkedin, instagram, linkedin]);
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "duplicate-channel",
          message:
            "The session lists a channel more than once: li1. Nothing is sent until the Worker's channel list is fixed.",
        },
      ]);
      expect(document.channels).toEqual([]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });
  });

  describe("when the state is written again during a run", () => {
    it("replaces the file through a draft, never in place", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const statePath = path.join(dir, "post.state.json");
      const calls: string[] = [];
      const { exitCode } = await client(["queue", job, "--send"], {
        fs: {
          readFile,
          writeFile: async (file: string, data: string, options: object) => {
            calls.push(
              `write ${path.basename(file)} ${JSON.stringify(options)}`,
            );
            return writeFile(file, data, options);
          },
          rename: async (from: string, to: string) => {
            calls.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
            return rename(from, to);
          },
        },
      });
      expect(exitCode).toBe(0);
      expect(calls[0]).toBe('write post.state.json {"flag":"wx"}');
      const later = calls.slice(1);
      expect(later.length).toBeGreaterThan(0);
      expect(later.length % 2).toBe(0);
      const drafts = new Set<string>();
      for (let index = 0; index < later.length; index += 2) {
        const draft = later[index].match(
          /^write (post\.state\.json\.[0-9a-f-]{36}\.tmp) \{"flag":"wx","flush":true\}$/,
        )?.[1];
        expect(draft).toBeDefined();
        expect(later[index + 1]).toBe(`rename ${draft} -> post.state.json`);
        drafts.add(draft as string);
      }
      // Every write has a draft of its own, and none is left behind.
      expect(drafts.size).toBe(later.length / 2);
      expect(
        (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      expect((await readState()).channels.li1.step).toBe("created");
      expect(JSON.parse(await readFile(statePath, "utf8")).version).toBe(1);
    });

    it("never writes through a file that waits under a predictable draft name", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      // What a link planted next to the state would point at.
      const planted = path.join(dir, "post.state.json.tmp");
      await writeFile(planted, "not the client's file");

      const { exitCode } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(0);
      expect(await readFile(planted, "utf8")).toBe("not the client's file");
      expect((await readState()).channels.li1.step).toBe("created");
    });

    it("clears away the draft of a write that failed", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      let writes = 0;
      await client(["queue", job, "--send"], {
        fs: {
          readFile,
          rename,
          unlink,
          writeFile: async (file: string, data: string, options: object) => {
            if (++writes !== 3) return writeFile(file, data, options);
            await writeFile(file, data.slice(0, 10), options);
            throw Object.assign(new Error("killed"), { code: "EIO" });
          },
        },
      });
      expect(
        (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    });

    it("keeps the last complete state when a write dies half-way", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const statePath = path.join(dir, "post.state.json");
      let writes = 0;
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fs: {
          readFile,
          rename,
          // The third write of the run stops after half of its content.
          writeFile: async (file: string, data: string, options: object) => {
            if (++writes !== 3) return writeFile(file, data, options);
            await writeFile(file, data.slice(0, Math.floor(data.length / 2)));
            throw Object.assign(new Error("killed"), { code: "EIO" });
          },
        },
      });
      expect(exitCode).toBe(1);
      expect(document.channels[0].outcome).toBe("failed");
      const kept = JSON.parse(await readFile(statePath, "utf8"));
      expect(kept.channels.li1.requestId).toBe(document.channels[0].requestId);
      expect(count().posts).toBe(0);
    });
  });

  describe("when a write fails in the middle of a run", () => {
    const failingFrom = (failAt: number) => {
      let writes = 0;
      return {
        readFile,
        rename,
        writeFile: async (file: string, data: string, options: object) => {
          if (++writes >= failAt)
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return writeFile(file, data, options);
        },
      };
    };

    it("still reports posts that exist when the state cannot be written at all", async () => {
      const job = await writeJob();
      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(0);
      seen.length = 0;

      const second = await client(["queue", job, "--send"], {
        fs: failingFrom(1),
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

    it("does not send a request whose state is not on disk", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      // The write before the upload is the second one of a run.
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fs: failingFrom(2),
      });
      expect(exitCode).toBe(1);
      expect(document.channels[0].outcome).toBe("failed");
      expect(document.channels[0].message).toMatch(
        /^Cannot write the state file .*ENOSPC\.$/,
      );
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("does not send the post when the write before it fails", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const { document } = await client(["queue", job, "--send"], {
        fs: failingFrom(4),
      });
      expect(document.channels[0].outcome).toBe("failed");
      expect(count()).toEqual({ session: 1, media: 1, posts: 0 });
    });

    describe("and the later writes go through", () => {
      const failingAt = (failAt: number) => {
        let writes = 0;
        return {
          readFile,
          rename,
          writeFile: async (file: string, data: string, options: object) => {
            if (++writes === failAt)
              throw Object.assign(new Error("busy"), { code: "EBUSY" });
            return writeFile(file, data, options);
          },
        };
      };

      it("does not record a post request that was never sent", async () => {
        const job = await writeJob();
        // The fourth write of a run is the one before the first post.
        const first = await client(["queue", job, "--send"], {
          fs: failingAt(4),
        });
        expect(first.exitCode).toBe(1);
        expect(first.document.channels.map(({ outcome }) => outcome)).toEqual([
          "failed",
          "created",
        ]);
        expect(count()).toEqual({ session: 1, media: 2, posts: 1 });
        const kept = (await readState()).channels.li1;
        expect(kept.step).toBe("uploaded");
        expect(kept.mediaId).toEqual(expect.any(String));

        seen.length = 0;
        const second = await client(["queue", job, "--send"]);
        expect(second.exitCode).toBe(0);
        expect(second.document.channels.map(({ outcome }) => outcome)).toEqual([
          "created",
          "already-created",
        ]);
        // The upload of the first run is used again.
        expect(count()).toEqual({ session: 1, media: 0, posts: 1 });
      });

      it("does not record an upload that was never started", async () => {
        const job = await writeJob();
        // The second write of a run is the one before the first upload.
        const { document } = await client(["queue", job, "--send"], {
          fs: failingAt(2),
        });
        expect(document.channels.map(({ outcome }) => outcome)).toEqual([
          "failed",
          "created",
        ]);
        expect((await readState()).channels.li1.step).toBe("prepared");
        expect(count()).toEqual({ session: 1, media: 1, posts: 1 });
      });
    });

    it("still reports a created post and says the state lacks it", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fs: failingFrom(5),
      });
      expect(exitCode).toBe(1);
      expect(document.ok).toBe(false);
      expect(document.channels[0]).toMatchObject({
        outcome: "created",
        postId: "post1",
      });
      expect(document.errors).toHaveLength(1);
      expect(document.errors[0].code).toBe("state-failed");
      expect(document.errors[0].message).toMatch(
        /ENOSPC\. The result of linkedin \(li1\) \(created\) is not in the state file: do not run this job again before the file is fixed\.$/,
      );
    });

    // The fifth write of a run is the result of its first channel.
    const failingOnce = (failAt: number) => {
      let writes = 0;
      return {
        readFile,
        rename,
        unlink,
        writeFile: async (file: string, data: string, options: object) => {
          if (++writes === failAt)
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return writeFile(file, data, options);
        },
      };
    };

    it.each([
      ["a later channel's write", {}, ["li1", "ig1"]],
      ["the last try of the run", { channels: ["linkedin"] }, ["li1"]],
    ])("takes the error back once %s has recorded the result", async (_name, change, ids) => {
      const job = await writeJob(change);
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fs: failingOnce(5),
      });
      expect(document.errors).toEqual([]);
      expect(exitCode).toBe(0);
      expect(document.ok).toBe(true);
      const state = await readState();
      for (const [index, id] of ids.entries()) {
        expect(document.channels[index]).toMatchObject({
          id,
          outcome: "created",
        });
        expect(state.channels[id]).toMatchObject({
          step: "created",
          postId: document.channels[index].postId,
        });
      }

      // The file is whole: a second run sends nothing.
      seen.length = 0;
      const again = await client(["queue", job, "--send"]);
      expect(again.exitCode).toBe(0);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });
  });

  describe("when the session lists a channel of the state under another network", () => {
    it.each([
      ["a network", { channels: ["linkedin"] }],
      ["every channel", {}],
    ])("refuses the run for a job that names %s", async (_name, change) => {
      const job = await writeJob(change);
      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(0);
      const statePath = path.join(dir, "post.state.json");
      const before = await readFile(statePath, "utf8");
      env.CHANNELS_JSON = JSON.stringify([
        { ...linkedin, service: "facebook" },
        instagram,
      ]);
      seen.length = 0;

      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const { exitCode, document } = await client(argv);
        expect(exitCode).toBe(1);
        expect(document.errors).toEqual([
          {
            code: "state-mismatch",
            message: `The state file (${statePath}) has li1 as linkedin, and the session lists li1 as facebook. A channel does not change its network: fix the Worker's channel list, or use another state file (--state).`,
          },
        ]);
        expect(document.channels).toEqual([]);
      }
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
      expect(await readFile(statePath, "utf8")).toBe(before);
    });
  });

  describe("when the session corrects the network of a channel that was never sent", () => {
    const relabel = () => {
      env.CHANNELS_JSON = JSON.stringify([
        { ...linkedin, service: "facebook" },
        instagram,
      ]);
      seen.length = 0;
    };

    it("sends a job that only had dry runs, under the network of the session", async () => {
      const job = await writeJob();
      const dry = await client(["queue", job]);
      expect((await readState()).channels.li1.service).toBe("linkedin");
      relabel();

      const sent = await client(["queue", job, "--send"]);
      expect(sent.document.errors).toEqual([]);
      expect(sent.exitCode).toBe(0);
      expect(sent.document.channels[0]).toMatchObject({
        id: "li1",
        service: "facebook",
        requestId: dry.document.channels[0].requestId,
        outcome: "created",
      });
      expect((await readState()).channels.li1.service).toBe("facebook");
    });

    it("takes no notice of an entry a dry run left for a channel outside the send", async () => {
      const job = await writeJob();
      await client(["queue", job]);
      await writeJob({ channels: ["instagram"] });
      const sent = await client(["queue", job, "--send"]);
      expect(sent.exitCode).toBe(0);
      const state = await readState();
      expect(state.targets).toEqual(["ig1"]);
      expect(state.channels.li1.service).toBe("linkedin");
      relabel();

      const again = await client(["queue", job, "--send"]);
      expect(again.document.errors).toEqual([]);
      expect(again.exitCode).toBe(0);
      expect(outcomes(again.document.channels)).toEqual({
        ig1: "already-created",
      });
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });
  });

  describe("when the session no longer lists a channel of the first send", () => {
    // LinkedIn leaves the session after the first run.
    const withoutLinkedin = () => {
      env.CHANNELS_JSON = JSON.stringify([instagram]);
      seen.length = 0;
    };
    const notSent = (step: string) =>
      `The session no longer lists this channel, so it was not sent. Its last recorded step is "${step}".`;

    it.each([
      ["every channel", {}],
      ["networks", { channels: ["linkedin", "instagram"] }],
      ["channel IDs", { channels: ["li1", "ig1"] }],
      [
        "a text for the channel that left",
        { channelText: { linkedin: "For LinkedIn" } },
      ],
    ])("still reports its post for a job that names %s", async (_name, change) => {
      const job = await writeJob(change);
      const first = await client(["queue", job, "--send"]);
      expect(first.exitCode).toBe(0);
      const before = await readFile(path.join(dir, "post.state.json"), "utf8");
      withoutLinkedin();

      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const again = await client(argv);
        expect(again.document.errors).toEqual([]);
        expect(again.exitCode).toBe(0);
        expect(again.document.channels).toEqual([
          expect.objectContaining({
            id: "ig1",
            name: instagram.name,
            outcome: "already-created",
            postId: first.document.channels[1].postId,
          }),
          expect.objectContaining({
            id: "li1",
            service: "linkedin",
            requestId: first.document.channels[0].requestId,
            outcome: "already-created",
            postId: first.document.channels[0].postId,
          }),
        ]);
        expect(again.document.channels[1]).not.toHaveProperty("name");
      }
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
      expect(await readFile(path.join(dir, "post.state.json"), "utf8")).toBe(
        before,
      );
    });

    it("does not call a job done whose channel was refused and then left", async () => {
      const job = await writeJob();
      // LinkedIn leaves the allowlist after the session listed it.
      standIn.afterAnswer = (request) => {
        if (request.path === "/api/buffer/session")
          env.CHANNELS_JSON = JSON.stringify([instagram]);
      };
      const first = await client(["queue", job, "--send"]);
      expect(outcomes(first.document.channels)).toEqual({
        li1: "refused",
        ig1: "created",
      });
      standIn.afterAnswer = () => {};
      const before = await readFile(path.join(dir, "post.state.json"), "utf8");
      withoutLinkedin();

      const again = await client(["queue", job, "--send"]);
      expect(again.exitCode).toBe(1);
      expect(again.document.ok).toBe(false);
      expect(again.document.channels).toEqual([
        expect.objectContaining({ id: "ig1", outcome: "already-created" }),
        expect.objectContaining({
          id: "li1",
          requestId: first.document.channels[0].requestId,
          outcome: "failed",
          status: 403,
          message: notSent("refused"),
        }),
      ]);
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
      expect(await readFile(path.join(dir, "post.state.json"), "utf8")).toBe(
        before,
      );

      // Back in the session, it goes out with the request ID it had.
      env.CHANNELS_JSON = JSON.stringify([linkedin, instagram]);
      const back = await client(["queue", job, "--send"]);
      expect(back.exitCode).toBe(0);
      expect(back.document.channels[0]).toMatchObject({
        id: "li1",
        requestId: first.document.channels[0].requestId,
        outcome: "created",
      });
    });

    it("keeps pointing at a post with no known result", async () => {
      const job = await writeJob();
      await client(["queue", job, "--send"]);
      const state = await readState();
      const { postId: _postId, ...sent } = state.channels.li1;
      state.channels.li1 = { ...sent, step: "posting" };
      await writeFile(path.join(dir, "post.state.json"), JSON.stringify(state));
      withoutLinkedin();

      const again = await client(["queue", job, "--send"]);
      expect(again.exitCode).toBe(1);
      expect(again.document.channels[1]).toMatchObject({
        id: "li1",
        outcome: "unknown",
        message: `An earlier run sent this post and recorded no result. ${CHECK_BUFFER}`,
      });
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("refuses a job that changed after the post of such a channel was created", async () => {
      const job = await writeJob();
      await client(["queue", job, "--send"]);
      await writeJob({ text: "Another text" });
      withoutLinkedin();

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("state-mismatch");
      expect(document.errors[0].message).toMatch(
        /^The job changed after a post was created for instagram \(ig1\), linkedin \(li1\)\./,
      );
      expect(count()).toEqual({ session: 1, media: 0, posts: 0 });
    });

    it("leaves the channel out when the job no longer means it", async () => {
      const job = await writeJob();
      await client(["queue", job, "--send"]);
      await writeJob({ channels: ["instagram"] });
      withoutLinkedin();

      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(0);
      expect(outcomes(document.channels)).toEqual({ ig1: "already-created" });
    });

    it("still refuses a name that means no channel at all", async () => {
      const job = await writeJob();
      await client(["queue", job, "--send"]);
      await writeJob({ channels: ["linkedin", "threads"] });
      withoutLinkedin();

      const { document } = await client(["queue", job, "--send"]);
      expect(document.errors[0].code).toBe("unknown-channel");
      expect(document.errors[0].message).toMatch(
        /^channels: "threads" is not a channel of this session\. /,
      );
    });
  });
});
