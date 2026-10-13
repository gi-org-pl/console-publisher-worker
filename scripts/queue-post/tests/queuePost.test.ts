// @vitest-environment node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bufferFetch,
  bufferPosts,
  type Channel,
  clientId,
  clientSecret,
  count,
  dir,
  png,
  script,
  seen,
  standIn,
  token,
  useWorkerStandIn,
  viaWorker,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

const both = ["li1", "ig1"];
const statuses = (channels: Channel[]) =>
  Object.fromEntries(channels.map((c) => [c.channelId, c.status]));

describe("check", () => {
  it("prints the status and the answer of the session request, and sends nothing else", async () => {
    const { exitCode, document } = await script(["check"]);
    expect(exitCode).toBe(0);
    expect(document).toEqual({
      ok: true,
      command: "check",
      results: [
        {
          step: "session",
          status: 200,
          response: {
            service: "gieniek-bot",
            channels: expect.arrayContaining([expect.any(Object)]),
          },
        },
      ],
    });
    expect(seen).toHaveLength(1);
  });

  it("reports a refusal with its status and the Worker's words", async () => {
    const { exitCode, document } = await script(["check"], {
      env: { ...token, CF_ACCESS_CLIENT_SECRET: `${clientSecret}0` },
    });
    expect(exitCode).toBe(1);
    expect(document.results[0]).toMatchObject({
      status: 401,
      response: { message: "Sign in via Cloudflare Access." },
    });
  });

  it("does not follow a redirect: the answer is the redirect itself", async () => {
    standIn.answer = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.org/login" },
      });
    const { exitCode, document } = await script(["check"]);
    expect(exitCode).toBe(1);
    expect(document.results[0]).toMatchObject({ status: 302, response: "" });
    expect(seen).toHaveLength(1);
  });

  it("prints an answer that is not JSON as text", async () => {
    standIn.answer = () => new Response("<html>", { status: 502 });
    const { document } = await script(["check"]);
    expect(document.results[0]).toMatchObject({
      status: 502,
      response: "<html>",
    });
  });

  it.each([
    [
      "no answer",
      async () => {
        throw new TypeError("fetch failed");
      },
      "No answer from the Console: fetch failed.",
    ],
    [
      "an answer after the timeout",
      (_: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("timed out")),
          ),
        ),
      "No answer from the Console: timed out.",
    ],
  ])("reports %s with status 0", async (_name, fetch, response) => {
    const { exitCode, document } = await script(["check"], {
      fetch,
      timeoutMs: 10,
    });
    expect(exitCode).toBe(1);
    expect(document.results[0]).toMatchObject({ status: 0, response });
  });

  it.each([
    [[]],
    [["publish", "post.json"]],
    [["check", "post.json"]],
    [["queue"]],
    [["queue", "post.json", "extra"]],
    [["queue", "post.json", "--credential"]],
    [["queue", "--send"]],
    [["check", "--url", "http://127.0.0.1:9"]],
  ])("answers %j with the usage before anything else", async (argv) => {
    const { exitCode, document } = await script(argv);
    expect(exitCode).toBe(1);
    expect(document).toEqual({
      ok: false,
      command: null,
      error: expect.stringMatching(/^Usage: /),
    });
    expect(seen).toHaveLength(0);
  });
});

describe("preview", () => {
  it("prints what queue would send and sends nothing", async () => {
    const job = await writeJob({ channels: both });
    const { exitCode, document } = await script(["preview", job]);
    expect(exitCode).toBe(0);
    expect(document).toEqual({
      ok: true,
      command: "preview",
      name: "autumn-news",
      text: "Hello from the job",
      image: "post.png",
      channels: [
        { channelId: "li1", requestId: expect.any(String) },
        { channelId: "ig1", requestId: expect.any(String) },
      ],
    });
    expect(seen).toHaveLength(0);
    expect(bufferFetch).not.toHaveBeenCalled();
  });

  it("prints the request IDs a later queue uses", async () => {
    const job = await writeJob({ channels: both });
    const preview = await script(["preview", job]);
    const queue = await script(["queue", job]);
    expect(queue.document.results.map((r: Channel) => r.requestId)).toEqual(
      preview.document.channels.map((c: Channel) => c.requestId),
    );
  });

  it("gives another Client ID request IDs of its own", async () => {
    const job = await writeJob({ channels: ["li1"] });
    const mine = await script(["preview", job]);
    const other = await script(["preview", job], {
      env: { ...token, CF_ACCESS_CLIENT_ID: `${"0".repeat(32)}.access` },
    });
    expect(other.document.channels[0].requestId).not.toBe(
      mine.document.channels[0].requestId,
    );
  });

  it("gives another post name request IDs of its own, in the shape of a UUID", async () => {
    const first = await script(["preview", await writeJob({ channels: both })]);
    const second = await script([
      "preview",
      await writeJob({ channels: both, name: "winter-news" }),
    ]);
    const ids = [...first.document.channels, ...second.document.channels].map(
      (c: Channel) => c.requestId as string,
    );
    expect(new Set(ids).size).toBe(4);
    for (const id of ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
  });
});

describe("queue", () => {
  it("uploads the image once and creates one queued post per channel", async () => {
    const job = await writeJob({ channels: both });
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(0);
    expect(document).toMatchObject({
      ok: true,
      command: "queue",
      name: "autumn-news",
    });
    expect(document.results).toEqual([
      {
        channelId: "li1",
        requestId: expect.any(String),
        step: "post",
        status: 200,
        response: { postId: "post1" },
      },
      {
        channelId: "ig1",
        requestId: expect.any(String),
        step: "post",
        status: 200,
        response: { postId: "post2" },
      },
    ]);
    expect(count("session")).toBe(0);
    expect(count("media")).toBe(1);
    expect(count("posts")).toBe(2);
    expect(bufferPosts()).toEqual([
      expect.objectContaining({ channelId: "li1", mode: "addToQueue" }),
      expect.objectContaining({ channelId: "ig1", text: "Hello from the job" }),
    ]);
  });

  it("posts only to the channels the job names", async () => {
    const { document } = await script([
      "queue",
      await writeJob({ channels: ["li1"] }),
    ]);
    expect(statuses(document.results)).toEqual({ li1: 200 });
    expect(bufferFetch).toHaveBeenCalledTimes(1);
  });

  it("prints the Worker's answer for a channel it refuses and exits with 1", async () => {
    const { exitCode, document } = await script([
      "queue",
      await writeJob({ channels: ["li1", "nope"] }),
    ]);
    expect(exitCode).toBe(1);
    expect(document.results[0].status).toBe(200);
    expect(document.results[1].status).toBeGreaterThanOrEqual(400);
    expect(document.results[1].response).toHaveProperty("message");
  });

  describe("when the same job is run again", () => {
    it("creates no second post: the Worker answers 409 for each channel", async () => {
      const job = await writeJob({ channels: both });
      await script(["queue", job]);
      const again = await script(["queue", job]);
      expect(again.exitCode).toBe(1);
      expect(again.document.results).toEqual([
        expect.objectContaining({
          channelId: "li1",
          status: 409,
          response: {
            message:
              "This request was already sent. Check Buffer before creating another post.",
          },
        }),
        expect.objectContaining({ channelId: "ig1", status: 409 }),
      ]);
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });

    it("creates none for a changed text under the same name either", async () => {
      await script(["queue", await writeJob({ channels: both })]);
      const changed = await script([
        "queue",
        await writeJob({ channels: both, text: "Another text" }),
      ]);
      expect(statuses(changed.document.results)).toEqual({
        li1: 409,
        ig1: 409,
      });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });

    it("creates the post of a channel that was refused the first time, and only that one", async () => {
      const job = await writeJob({ channels: both });
      standIn.answer = (request) =>
        request.path === "/api/buffer/posts" && count("posts") === 2
          ? Response.json({ message: "Not allowed." }, { status: 403 })
          : undefined;
      const first = await script(["queue", job]);
      expect(statuses(first.document.results)).toEqual({ li1: 200, ig1: 403 });

      standIn.answer = () => undefined;
      const second = await script(["queue", job]);
      expect(statuses(second.document.results)).toEqual({ li1: 409, ig1: 200 });
    });
  });

  it("prints a post request without a usable answer as it came, with its status", async () => {
    standIn.answer = (request) =>
      request.path === "/api/buffer/posts"
        ? Response.json({ message: "Buffer did not answer." }, { status: 502 })
        : undefined;
    const { exitCode, document } = await script([
      "queue",
      await writeJob({ channels: ["li1"] }),
    ]);
    expect(exitCode).toBe(1);
    expect(document.results[0]).toMatchObject({
      status: 502,
      response: { message: "Buffer did not answer." },
    });
  });

  it("reports a connection that broke on a post with status 0", async () => {
    const { document } = await script(
      ["queue", await writeJob({ channels: ["li1"] })],
      {
        fetch: (async (input, init) => {
          if (String(input).endsWith("/posts"))
            throw new TypeError("fetch failed");
          return viaWorker(input, init);
        }) as typeof fetch,
      },
    );
    expect(document.results[0]).toMatchObject({ step: "post", status: 0 });
  });

  it("posts nothing when the upload fails, and says so for every channel", async () => {
    standIn.answer = (request) =>
      request.path === "/api/buffer/media"
        ? Response.json({ message: "Too large." }, { status: 413 })
        : undefined;
    const { exitCode, document } = await script([
      "queue",
      await writeJob({ channels: both }),
    ]);
    expect(exitCode).toBe(1);
    expect(document.results).toEqual([
      expect.objectContaining({
        channelId: "li1",
        step: "upload",
        status: 413,
        response: { message: "Too large." },
      }),
      expect.objectContaining({
        channelId: "ig1",
        step: "upload",
        status: 413,
      }),
    ]);
    expect(count("media")).toBe(1);
    expect(count("posts")).toBe(0);
  });

  it("does not count an upload that answered 200 without a media ID as a success", async () => {
    standIn.answer = (request) =>
      request.path === "/api/buffer/media" ? Response.json({}) : undefined;
    const { exitCode } = await script([
      "queue",
      await writeJob({ channels: ["li1"] }),
    ]);
    expect(exitCode).toBe(1);
    expect(count("posts")).toBe(0);
  });
});

describe("the token", () => {
  it("is removed from the Worker's words, also when a cut would have split it", async () => {
    standIn.answer = () =>
      Response.json(
        { message: `No access for ${clientId} with ${clientSecret}` },
        { status: 403 },
      );
    const refused = await script(["check"]);
    expect(refused.document.results[0].response.message).toBe(
      "No access for [redacted] with [redacted]",
    );

    standIn.answer = (request) =>
      request.path === "/api/buffer/posts"
        ? Response.json({ message: `x${clientSecret}` }, { status: 400 })
        : undefined;
    const { document } = await script([
      "queue",
      await writeJob({ channels: ["li1"] }),
    ]);
    expect(document.results[0].response.message).toBe("x[redacted]");
  });

  it.each([
    ["a text holding the secret", { text: `see ${clientSecret}` }],
    ["a text holding the Client ID", { text: `see ${clientId}` }],
    ["a channel that is the secret", { channels: ["li1", clientSecret] }],
    ["a channel that holds the Client ID", { channels: [`${clientId}x`] }],
  ])("is never published: %s is refused before any request", async (_name, change) => {
    const job = await writeJob({ channels: ["li1"], ...change });
    for (const command of ["preview", "queue"]) {
      const { exitCode, document } = await script([command, job]);
      expect(exitCode).toBe(1);
      expect(document.error).toBe(
        "The text or a channel of the job contains the service token. Nothing was sent.",
      );
    }
    expect(seen).toHaveLength(0);
  });

  it("is missing: fails with a clear message and sends nothing", async () => {
    const { exitCode, document } = await script(["check"], { env: {} });
    expect(exitCode).toBe(1);
    expect(document.error).toMatch(/^Set CF_ACCESS_CLIENT_ID/);
    expect(document.command).toBe("check");
    expect(seen).toHaveLength(0);
  });

  it("comes from the credential store once, and is removed from an error about the job", async () => {
    const reader = vi.fn(async () => ({
      code: 0,
      stdout: Buffer.from(JSON.stringify({ clientId, clientSecret })).toString(
        "base64",
      ),
    }));
    const { document } = await script(
      ["queue", `${clientId}.json`, "--credential", "console-bot"],
      { env: {}, platform: "win32", runProcess: reader },
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(document.error).toBe("Cannot read the job: ENOENT.");
    expect(JSON.stringify(document)).not.toContain(clientId);
    expect(seen).toHaveLength(0);
  });
});

describe("the job", () => {
  it.each([
    ["a missing file", undefined, "Cannot read the job: ENOENT."],
    [
      "something that is not JSON",
      "API_KEY=sk-live-123",
      "Cannot read the job: it is not JSON in UTF-8.",
    ],
    [
      "an unknown key",
      { mode: "shareNow" },
      "The job is not valid: name, text, image and channels, and nothing else, are expected (see: job).",
    ],
    [
      "a name that is not a slug",
      { name: "Autumn News!" },
      "The job is not valid: name, text, image and channels, and nothing else, are expected (see: name).",
    ],
    [
      "the same channel twice",
      { channels: ["li1", "li1"] },
      "The job is not valid: name, text, image and channels, and nothing else, are expected (see: channels).",
    ],
    [
      "no channels",
      { channels: [] },
      "The job is not valid: name, text, image and channels, and nothing else, are expected (see: channels).",
    ],
  ])("refuses %s before any request", async (_name, content, message) => {
    await writeFile(path.join(dir, "post.png"), png());
    const base = { name: "autumn-news", text: "Hi", image: "post.png" };
    if (content !== undefined)
      await writeFile(
        path.join(dir, "post.json"),
        typeof content === "string"
          ? content
          : JSON.stringify({ ...base, channels: ["li1"], ...content }),
      );
    const { exitCode, document } = await script(["queue", "post.json"]);
    expect(exitCode).toBe(1);
    expect(document.error).toBe(message);
    expect(seen).toHaveLength(0);
  });

  it("refuses bytes that are not UTF-8 instead of publishing replacement characters", async () => {
    await writeFile(path.join(dir, "post.png"), png());
    await writeFile(
      path.join(dir, "post.json"),
      Buffer.concat([
        Buffer.from(
          '{"name":"autumn-news","image":"post.png","channels":["li1"],"text":"Hi ',
        ),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}'),
      ]),
    );
    const { exitCode, document } = await script(["queue", "post.json"]);
    expect(exitCode).toBe(1);
    expect(document.error).toBe(
      "Cannot read the job: ERR_ENCODING_INVALID_ENCODED_DATA.",
    );
    expect(seen).toHaveLength(0);
  });

  describe("when the image is not inside the folder of the job", () => {
    it.each([
      ["a file above the folder", "../outside.png", "is not inside the folder"],
      ["the folder itself", ".", "is not inside the folder"],
      ["an absolute path", path.join(os.tmpdir(), "x.png"), "has to be a path"],
      ["a network path", "//host/share/x.png", "has to be a path"],
      ["a missing file", "missing.png", "cannot be read"],
    ])("refuses %s before any request", async (_name, image, message) => {
      await mkdir(path.join(dir, "inner"));
      await writeFile(path.join(dir, "outside.png"), png());
      await writeFile(
        path.join(dir, "inner", "post.json"),
        JSON.stringify({
          name: "autumn-news",
          text: "Hi",
          image,
          channels: ["li1"],
        }),
      );
      const { exitCode, document } = await script(["queue", "inner/post.json"]);
      expect(exitCode).toBe(1);
      expect(document.error).toContain(`The image "${image}" ${message}`);
      expect(seen).toHaveLength(0);
    });

    it("accepts a name that only begins with two dots", async () => {
      await mkdir(path.join(dir, "..assets"));
      await writeFile(path.join(dir, "..assets", "..hero.png"), png());
      const job = await writeJob({
        channels: ["li1"],
        image: "..assets/..hero.png",
      });
      const { exitCode } = await script(["queue", job]);
      expect(exitCode).toBe(0);
    });

    it("refuses a link that leads out of the folder", async (context) => {
      await mkdir(path.join(dir, "inner"));
      await writeFile(path.join(dir, "outside.png"), png());
      try {
        await symlink(
          path.join(dir, "outside.png"),
          path.join(dir, "inner", "link.png"),
        );
      } catch {
        // Windows allows links only to some users: nothing to test there.
        return context.skip();
      }
      await writeFile(
        path.join(dir, "inner", "post.json"),
        JSON.stringify({
          name: "autumn-news",
          text: "Hi",
          image: "link.png",
          channels: ["li1"],
        }),
      );
      const { document } = await script(["queue", "inner/post.json"]);
      expect(document.error).toContain("is not inside the folder");
      expect(seen).toHaveLength(0);
    });
  });
});
