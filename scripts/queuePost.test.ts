// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { R2Bucket } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker/index";
import { run } from "./queuePost.mjs";

// The script runs here against the Worker's own code: its requests go
// straight into `worker.fetch`. Access, R2 and Buffer are stand-ins; nothing
// leaves the machine.

const { clientId, clientSecret } = vi.hoisted(() => ({
  clientId: "e367826f93b8d71185e03fe518aff3b4.access",
  clientSecret:
    "f00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dface",
}));
vi.mock("../src/worker/auth", () => ({
  // Stands in for Cloudflare Access: one service token gets through.
  authenticate: async (request: Request) => {
    if (
      request.headers.get("CF-Access-Client-Id") !== clientId ||
      request.headers.get("CF-Access-Client-Secret") !== clientSecret
    )
      throw new Error("Access refused the token");
    return { kind: "service", clientId };
  },
}));

const origin = "https://console.gi.org.pl";
const linkedin = {
  id: "li1",
  name: "Foundation LinkedIn",
  service: "linkedin",
};
const instagram = {
  id: "ig1",
  name: "Foundation Instagram",
  service: "instagram",
};
const token = {
  CF_ACCESS_CLIENT_ID: clientId,
  CF_ACCESS_CLIENT_SECRET: clientSecret,
};

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}
type Channel = Record<string, unknown>;

let env: Env;
let dir: string;
let seen: Seen[];
/** Answers in place of the Worker when it returns a response. */
let answer: (request: Seen) => Response | undefined;
let bufferFetch: ReturnType<typeof vi.fn>;
/** Everything the script returned, checked for the secret afterwards. */
let outputs: string[];

function png(size = 24) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, 1080);
  new DataView(bytes.buffer).setUint32(20, 1080);
  return bytes;
}

/** The script's `fetch`: the Worker itself, or what a test puts in its place. */
const viaWorker: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== origin) throw new Error(`A test tried to reach ${url}`);
  const request: Seen = {
    method: init?.method ?? "GET",
    path: url.pathname,
    headers: new Headers(init?.headers),
    redirect: init?.redirect,
  };
  seen.push(request);
  return (
    answer(request) ??
    worker.fetch(
      new Request(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      }),
      env,
    )
  );
};

async function script(argv: string[], overrides: Record<string, unknown> = {}) {
  const before = await readdir(dir, { recursive: true });
  const result = await run(argv, {
    env: token,
    platform: "linux",
    cwd: dir,
    fetch: viaWorker,
    runProcess: () => {
      throw new Error("The credential store must not be read here");
    },
    ...overrides,
  });
  outputs.push(JSON.stringify(result.document));
  // The script keeps no state: a run leaves the folder as it found it.
  expect(await readdir(dir, { recursive: true })).toEqual(before);
  return result;
}

async function writeJob(job: Record<string, unknown> = {}, name = "post.json") {
  await writeFile(path.join(dir, "post.png"), png());
  await writeFile(
    path.join(dir, name),
    JSON.stringify({
      name: "autumn-news",
      text: "Hello from the job",
      image: "post.png",
      ...job,
    }),
  );
  return name;
}

const count = (route: string) =>
  seen.filter((request) => request.path === `/api/buffer/${route}`).length;
const outcomes = (channels: Channel[]) =>
  Object.fromEntries(channels.map((channel) => [channel.id, channel.outcome]));
/** What Buffer was asked to create. */
const bufferPosts = () =>
  bufferFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).variables.input,
  );

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(path.join(os.tmpdir(), "queue-post-"));
  seen = [];
  outputs = [];
  answer = () => undefined;
  let posts = 0;
  bufferFetch = vi.fn(async () =>
    Response.json({ data: { createPost: { post: { id: `post${++posts}` } } } }),
  );
  vi.stubGlobal("fetch", bufferFetch);
  const objects = new Map<
    string,
    { value: unknown; customMetadata?: Record<string, string> }
  >();
  env = {
    APP_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    BUFFER_API_KEY: "buffer-key",
    CHANNELS_JSON: JSON.stringify([linkedin, instagram]),
    SERVICES_JSON: JSON.stringify([{ clientId, name: "gieniek-bot" }]),
    MEDIA: {
      head: async (key: string) => objects.get(key) ?? null,
      get: async (key: string) =>
        objects.has(key)
          ? {
              body: objects.get(key)?.value,
              json: async () => JSON.parse(String(objects.get(key)?.value)),
            }
          : null,
      put: async (
        key: string,
        value: unknown,
        options?: {
          onlyIf?: unknown;
          customMetadata?: Record<string, string>;
        },
      ) => {
        if (options?.onlyIf && objects.has(key)) return null;
        objects.set(key, { value, customMetadata: options?.customMetadata });
        return { key };
      },
    } as unknown as R2Bucket,
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Held for every test of this file: the token is in no output, and no
  // request carried an Origin header or followed a redirect.
  for (const output of outputs) {
    expect(output).not.toContain(clientSecret);
    expect(output).not.toContain(clientId);
  }
  for (const request of seen) {
    expect(request.headers.get("origin")).toBeNull();
    expect(request.redirect).toBe("manual");
  }
  await rm(dir, { recursive: true, force: true });
});

describe("check", () => {
  describe("when the token is valid", () => {
    it("prints the service and its channels after one request", async () => {
      const { exitCode, document } = await script(["check"]);
      expect(exitCode).toBe(0);
      expect(document).toEqual({
        ok: true,
        command: "check",
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(seen).toHaveLength(1);
    });
  });

  describe("when Access refuses the token", () => {
    it("reports the refusal and its status", async () => {
      const { exitCode, document } = await script(["check"], {
        env: { ...token, CF_ACCESS_CLIENT_SECRET: `${clientSecret}0` },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
    });
  });

  describe("when the answer is not the Worker's", () => {
    it.each([
      [
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.org/login" },
          }),
        302,
        "The Console answered 302 without a message.",
      ],
      [
        () => new Response("<html>", { status: 502 }),
        502,
        "The Console answered 502 without a message.",
      ],
      [
        () => Response.json({ service: "gieniek-bot" }),
        200,
        "The session answer is not what the Worker's schema describes.",
      ],
    ])("reports it and sends nothing else", async (response, status, message) => {
      answer = response;
      const { document } = await script(["check"]);
      expect(document.errors).toEqual([
        { code: "session-failed", status, message },
      ]);
      expect(seen).toHaveLength(1);
    });
  });

  describe("when no answer arrives", () => {
    it("reports it without a status", async () => {
      const { document } = await script(["check"], {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          message: "No answer from the Console: fetch failed.",
        },
      ]);
    });
  });

  describe("when the arguments are wrong", () => {
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
      expect(document.errors).toEqual([
        {
          code: "invalid-arguments",
          message: expect.stringMatching(/^Usage: /),
        },
      ]);
      expect(seen).toHaveLength(0);
    });
  });
});

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
      answer = (request) =>
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

      answer = () => undefined;
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
      answer = (request) =>
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
      answer = (request) =>
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

describe("the job", () => {
  describe("when it cannot be used", () => {
    it.each([
      ["a missing file", undefined, "Cannot read the job: ENOENT."],
      [
        "something that is not JSON",
        "API_KEY=sk-live-123",
        "Cannot read the job: it is not JSON in UTF-8.",
      ],
      [
        "an unknown key",
        JSON.stringify({
          name: "autumn-news",
          text: "Hello",
          image: "post.png",
          mode: "shareNow",
        }),
        "The job is not valid: job: has keys this script does not know.",
      ],
      [
        "a name that is not a slug",
        JSON.stringify({
          name: "Autumn News!",
          text: "Hello",
          image: "post.png",
        }),
        "The job is not valid: name: 3 to 64 lower-case letters, digits and hyphens.",
      ],
    ])("refuses %s before any request", async (_name, content, message) => {
      await writeFile(path.join(dir, "post.png"), png());
      if (content !== undefined)
        await writeFile(path.join(dir, "post.json"), content);
      const { exitCode, document } = await script(["queue", "post.json"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([{ code: "invalid-job", message }]);
      expect(seen).toHaveLength(0);
    });

    it.each([
      [
        "an empty text",
        { text: "   " },
        /^The post for linkedin \(li1\) would be refused: text: /,
      ],
      [
        "a text over the Worker's limit",
        { text: "a".repeat(5001) },
        /^The post for linkedin \(li1\) would be refused: text: /,
      ],
      [
        "a channel the session does not have",
        { channels: ["facebook"] },
        /^Not a channel of this session: facebook\. The session has: linkedin \(li1\), instagram \(ig1\)\.$/,
      ],
      [
        "an override for a channel the session does not have",
        { overrides: { x: { text: "Hi" } } },
        /^Not a channel of this session: x\./,
      ],
    ])("refuses %s after the session and sends nothing", async (_name, change, message) => {
      const job = await writeJob(change);
      const { document } = await script(["queue", job]);
      expect(document.errors).toEqual([
        { code: "invalid-job", message: expect.stringMatching(message) },
      ]);
      expect(count("media") + count("posts")).toBe(0);
    });

    it("refuses a text that holds the token, without repeating it", async () => {
      const job = await writeJob({
        overrides: { ig1: { text: `secret: ${clientSecret}` } },
      });
      const { document } = await script(["queue", job]);
      expect(document.errors).toEqual([
        {
          code: "invalid-job",
          message:
            "The text for instagram (ig1) contains the service token. Nothing was sent.",
        },
      ]);
      expect(count("media") + count("posts")).toBe(0);
    });
  });

  describe("when an image is not a PNG inside the folder of the job", () => {
    it.each([
      [
        "a file above the folder",
        "../outside.png",
        'The image "../outside.png" is not inside the folder of the job.',
      ],
      [
        "an absolute path",
        path.join(os.tmpdir(), "outside.png"),
        "has to be a path inside the folder of the job.",
      ],
      [
        "a network path",
        "//host/share/outside.png",
        "has to be a path inside the folder of the job.",
      ],
      [
        "a missing file",
        "post-missing.png",
        'The image "post-missing.png" cannot be read.',
      ],
      [
        "a file that is not a PNG",
        "post-text.png",
        'The image "post-text.png" is not a PNG.',
      ],
      [
        "a file over the limit",
        "post-huge.png",
        'The image "post-huge.png" is larger than 5 MB.',
      ],
      [
        "the folder itself",
        ".",
        'The image "." is not inside the folder of the job.',
      ],
    ])("refuses %s before any request", async (_name, image, message) => {
      await mkdir(path.join(dir, "inner"));
      await writeFile(path.join(dir, "outside.png"), png());
      await writeFile(
        path.join(dir, "inner", "post-text.png"),
        "not a picture",
      );
      await writeFile(
        path.join(dir, "inner", "post-huge.png"),
        png(5 * 1024 * 1024 + 1),
      );
      await writeFile(
        path.join(dir, "inner", "post.json"),
        JSON.stringify({ name: "autumn-news", text: "Hello", image }),
      );
      const { exitCode, document } = await script(["queue", "inner/post.json"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "invalid-job", message: expect.stringContaining(message) },
      ]);
      expect(seen).toHaveLength(0);
    });
  });
});

describe("the token", () => {
  describe("when the other side repeats it", () => {
    it("is removed from the session error and from a channel's message", async () => {
      answer = () =>
        Response.json(
          { message: `No access for ${clientId} with ${clientSecret}` },
          { status: 403 },
        );
      const refused = await script(["check"]);
      expect(refused.document.errors[0].message).toBe(
        "No access for [redacted] with [redacted]",
      );

      const job = await writeJob({ channels: ["li1"] });
      answer = (request) =>
        request.path === "/api/buffer/posts"
          ? Response.json(
              { message: `${"x".repeat(470)}${clientSecret}` },
              { status: 400 },
            )
          : undefined;
      const { document } = await script(["queue", job]);
      expect(document.channels[0].outcome).toBe("refused");
      expect(document.channels[0].message).toBe(`${"x".repeat(470)}[redacted]`);
    });
  });

  describe("when it is missing", () => {
    it("fails with a clear message and sends nothing", async () => {
      const { exitCode, document } = await script(["check"], { env: {} });
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("missing-credentials");
      expect(seen).toHaveLength(0);
    });
  });

  describe("when it comes from the credential store", () => {
    it("is read once and removed from an error about the job", async () => {
      const reader = vi.fn(async () => ({
        code: 0,
        stdout: Buffer.from(
          JSON.stringify({ clientId, clientSecret }),
        ).toString("base64"),
      }));
      const { document } = await script(
        ["queue", `${clientId}.json`, "--credential", "console-bot"],
        {
          env: {},
          platform: "win32",
          runProcess: reader,
        },
      );
      expect(reader).toHaveBeenCalledTimes(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(seen).toHaveLength(0);
    });
  });

  describe("when something unforeseen throws with it", () => {
    it.each([
      [new Error(`EIO near ${clientSecret}`), "EIO near [redacted]"],
      [`a plain value with ${clientId}`, "a plain value with [redacted]"],
    ])("still returns the document, without the token", async (thrown, message) => {
      const job = await writeJob();
      const { exitCode, document } = await script(["preview", job], {
        fs: {
          readFile,
          stat,
          realpath: async () => {
            throw thrown;
          },
        },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([{ code: "unexpected", message }]);
      expect(seen).toHaveLength(0);
    });
  });
});
