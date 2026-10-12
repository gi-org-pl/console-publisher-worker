// @vitest-environment node
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import worker, { type Env } from "../src/worker/index";
import { CHECK_BUFFER } from "./publishJob.mjs";
import { type Report, run, runProcess } from "./publishPost.mjs";

// The client runs here against the Worker's own code, served on 127.0.0.1.
// Access, R2 and Buffer are stand-ins; nothing leaves the machine.

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

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
type ChannelResult = Report["channels"][number];

const realFetch = globalThis.fetch;
const script = fileURLToPath(new URL("./publishPost.mjs", import.meta.url));
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
const credentials = {
  CF_ACCESS_CLIENT_ID: clientId,
  CF_ACCESS_CLIENT_SECRET: clientSecret,
};

let server: Server;
let origin: string;
let env: Env;
let dir: string;
let seen: Seen[];
/** Answers in place of the Worker when it returns a response. */
let answer: (request: Seen) => Response | undefined;
/** Runs after the Worker answered, to change its configuration mid-run. */
let afterAnswer: (request: Seen) => void;
let bufferFetch: ReturnType<typeof vi.fn>;
let objects: Map<
  string,
  { value: unknown; customMetadata?: Record<string, string> }
>;
/** Everything the client printed or returned, checked for the secret afterwards. */
let outputs: string[];

function png(width = 1080, height = 1080) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** Only this machine's stand-in may be reached from a test. */
const localFetch: typeof fetch = (input, init) => {
  if (!String(input).startsWith(`${origin}/`))
    throw new Error(`A test tried to reach ${String(input)}`);
  return realFetch(input, init);
};

async function client(argv: string[], overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const result = await run([...argv, "--url", origin], {
    env: credentials,
    fetch: localFetch,
    log: (line: string) => logs.push(line),
    cwd: dir,
    platform: "linux",
    runProcess: () => {
      throw new Error("The credential store must not be read here");
    },
    ...overrides,
  });
  outputs.push(JSON.stringify(result.document), ...logs);
  return { ...result, logs };
}

/** The real command in its own process. */
function spawnClient(argv: string[], extraEnv: Record<string, string>) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...extraEnv,
  };
  if (!("CF_ACCESS_CLIENT_ID" in extraEnv)) delete childEnv.CF_ACCESS_CLIENT_ID;
  if (!("CF_ACCESS_CLIENT_SECRET" in extraEnv))
    delete childEnv.CF_ACCESS_CLIENT_SECRET;
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [script, ...argv, "--url", origin],
        { env: childEnv, cwd: dir },
        (error, stdout, stderr) => {
          outputs.push(stdout, stderr);
          resolve({
            exitCode: error ? Number(error.code) : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

async function writeJob(job: Record<string, unknown> = {}, name = "post.json") {
  await writeFile(path.join(dir, "post.png"), png());
  await writeFile(
    path.join(dir, name),
    JSON.stringify({ text: "Hello from the job", image: "post.png", ...job }),
  );
  return name;
}

async function readState(name = "post.state.json") {
  return JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
    version: number;
    channels: Record<
      string,
      {
        requestId: string;
        step: string;
        mediaId?: string;
        postId?: string;
        status?: number;
        message?: string;
      }
    >;
  };
}

function count() {
  const paths = seen.map((request) => request.path);
  return {
    session: paths.filter((item) => item === "/api/buffer/session").length,
    media: paths.filter((item) => item === "/api/buffer/media").length,
    posts: paths.filter((item) => item === "/api/buffer/posts").length,
  };
}

/** What Buffer was asked to create. */
function bufferPosts() {
  return bufferFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).variables.input,
  );
}

function outcomes(channels: ChannelResult[]) {
  return Object.fromEntries(
    channels.map((channel) => [channel.id, channel.outcome]),
  );
}

/** A time the given number of minutes from now, written with a +02:00 offset. */
function inMinutes(minutes: number) {
  return new Date(Date.now() + (minutes + 120) * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+02:00");
}

beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const request: Seen = {
      method: incoming.method ?? "",
      path: incoming.url ?? "",
      headers: incoming.headers,
      body: Buffer.concat(chunks),
    };
    seen.push(request);

    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      if (
        typeof value === "string" &&
        /^(origin|content-type|cf-access-)/.test(name)
      )
        headers.set(name, value);
    const response =
      answer(request) ??
      (await worker.fetch(
        new Request(`${origin}${request.path}`, {
          method: request.method,
          headers,
          body:
            request.body.length > 0 ? (request.body as BodyInit) : undefined,
        }),
        env,
      ));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    afterAnswer(request);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(path.join(os.tmpdir(), "publish-post-"));
  seen = [];
  outputs = [];
  answer = () => undefined;
  afterAnswer = () => {};
  let posts = 0;
  bufferFetch = vi.fn(async () =>
    Response.json({ data: { createPost: { post: { id: `post${++posts}` } } } }),
  );
  vi.stubGlobal("fetch", bufferFetch);
  objects = new Map();
  env = {
    APP_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    BUFFER_API_KEY: "buffer-key",
    CHANNELS_JSON: JSON.stringify([linkedin, instagram]),
    SERVICES_JSON: JSON.stringify([{ clientId, name: "gieniek-bot" }]),
    MEDIA: {
      head: async (key: string) => objects.get(key) ?? null,
      get: async (key: string) => {
        const object = objects.get(key);
        return object
          ? {
              body: object.value,
              json: async () => JSON.parse(String(object.value)),
            }
          : null;
      },
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
  // The acceptance criterion of the issue, held for every test in this file:
  // the secret is in no output and in no file the client wrote.
  for (const name of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, name);
    const content = await readFile(file, "latin1").catch(() => "");
    expect(content, file).not.toContain(clientSecret);
    expect(content, file).not.toContain(clientId);
  }
  for (const output of outputs) {
    expect(output).not.toContain(clientSecret);
    expect(output).not.toContain(clientId);
  }
  // No request carried an Origin header: a service must not send one.
  for (const request of seen) expect(request.headers.origin).toBeUndefined();
  await rm(dir, { recursive: true, force: true });
});

describe("check", () => {
  describe("when the credentials are valid", () => {
    it("prints the service and its channels after one request", async () => {
      const { exitCode, document, logs } = await client(["check"]);
      expect(exitCode).toBe(0);
      expect(document).toEqual({
        ok: true,
        command: "check",
        sent: false,
        url: origin,
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(logs).toEqual(["session: 200"]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: "GET",
        path: "/api/buffer/session",
        headers: {
          "cf-access-client-id": clientId,
          "cf-access-client-secret": clientSecret,
        },
      });
    });
  });

  describe("when the credentials are missing", () => {
    it.each([
      [{}, /^Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or pass/],
      [
        { CF_ACCESS_CLIENT_SECRET: clientSecret },
        /\(only CF_ACCESS_CLIENT_SECRET is set\)/,
      ],
      [
        { CF_ACCESS_CLIENT_ID: clientId },
        /\(only CF_ACCESS_CLIENT_ID is set\)/,
      ],
    ])("fails with a clear message and sends nothing", async (vars, message) => {
      const { exitCode, document } = await client(["check"], { env: vars });
      expect(exitCode).toBe(1);
      expect(document).toMatchObject({
        ok: false,
        command: "check",
        identity: null,
        channels: [],
        errors: [{ code: "missing-credentials" }],
      });
      expect(document.errors[0].message).toMatch(message);
      expect(seen).toHaveLength(0);
    });
  });

  describe("when the credentials cannot be a service token", () => {
    it.each([
      [
        {
          CF_ACCESS_CLIENT_ID: clientSecret,
          CF_ACCESS_CLIENT_SECRET: clientId,
        },
      ],
      [{ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: "a b" }],
    ])("refuses them before any request", async (vars) => {
      const { exitCode, document } = await client(["check"], { env: vars });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        expect.objectContaining({ code: "invalid-credentials" }),
      ]);
      expect(seen).toHaveLength(0);
    });
  });

  describe("when the session is refused", () => {
    it("reports what Access says to a wrong secret", async () => {
      const { exitCode, document } = await client(["check"], {
        env: { ...credentials, CF_ACCESS_CLIENT_SECRET: "0".repeat(64) },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
      expect(document.identity).toBeNull();
    });

    it("reports a service token that is not allowlisted", async () => {
      env.SERVICES_JSON = "[]";
      const { document } = await client(["check"]);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 403,
          message: "This service token is not allowed.",
        },
      ]);
    });

    it("does not follow a redirect with the credential headers", async () => {
      answer = (request) =>
        request.path === "/api/buffer/session"
          ? new Response(null, {
              status: 302,
              headers: { Location: `${origin}/elsewhere` },
            })
          : undefined;
      const { document } = await client(["check"]);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 302,
          message:
            "Redirected instead of answered: Cloudflare Access did not accept the credentials.",
        },
      ]);
      expect(seen.map((request) => request.path)).toEqual([
        "/api/buffer/session",
      ]);
    });

    it.each([
      [
        new Response("<html>Forbidden</html>", {
          status: 403,
          headers: { "Content-Type": "text/html" },
        }),
        403,
        "HTTP 403 without a message from the Worker.",
      ],
      [
        Response.json(null, { status: 500 }),
        500,
        "HTTP 500 without a message from the Worker.",
      ],
      [
        Response.json({ channels: [] }),
        200,
        "The session answer is not what the Worker's schema describes.",
      ],
    ])("reports an answer that is not the Worker's", async (response, status, message) => {
      answer = () => response;
      const { exitCode, document } = await client(["check"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "session-failed", status, message },
      ]);
    });
  });

  describe("when no answer arrives", () => {
    it("reports the failure without a status", async () => {
      const { document, logs } = await client(["check"], {
        fetch: async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect"), {
              code: "ECONNREFUSED",
            }),
          });
        },
      });
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          message: `No answer from ${origin}: fetch failed (ECONNREFUSED).`,
        },
      ]);
      expect(logs).toEqual(["session: no answer"]);
    });

    it("gives up after the time limit", async () => {
      const { document } = await client(["check"], {
        timeoutMs: 20,
        fetch: (_: unknown, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      });
      expect(document.errors[0].message).toBe(
        `No answer from ${origin}: no answer within 0.02 s.`,
      );
    });

    it("reports a failure that is not an error object", async () => {
      const { document } = await client(["check"], {
        fetch: async () => {
          throw "socket closed";
        },
      });
      expect(document.errors[0].message).toBe(
        `No answer from ${origin}: socket closed.`,
      );
    });
  });

  describe("when the arguments are wrong", () => {
    it("fails before anything else happens", async () => {
      const { exitCode, document } = await client(["publish"]);
      expect(exitCode).toBe(1);
      expect(document).toMatchObject({
        ok: false,
        command: null,
        errors: [{ code: "invalid-arguments" }],
      });
      expect(document.errors[0].message).toMatch(/^Unknown command publish\./);
      expect(seen).toHaveLength(0);
    });

    it("refuses to send the credentials to another host", async () => {
      const result = await run(["check", "--url", "https://example.org"], {
        env: credentials,
        fetch: localFetch,
        log: () => {},
      });
      outputs.push(JSON.stringify(result.document));
      expect(result.exitCode).toBe(1);
      expect(result.document.errors[0].code).toBe("invalid-arguments");
      expect(seen).toHaveLength(0);
    });
  });
});

describe("the Windows credential store", () => {
  const stored = (value: unknown) => ({
    code: 0,
    stdout: Buffer.from(JSON.stringify(value)).toString("base64"),
  });

  describe("when the environment has no credentials", () => {
    it("asks the reader for the named credential and uses it", async () => {
      const reader = vi.fn(async () =>
        stored({ clientId, clientSecret: clientSecret }),
      );
      const { exitCode, document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(0);
      expect(document.identity).toEqual({ service: "gieniek-bot" });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(
        expect.objectContaining({
          file: "powershell",
          env: { PUBLISH_POST_CREDENTIAL: "console-bot" },
        }),
      );
    });

    it.each([
      [
        { code: 3, stdout: "" },
        'The Windows credential store has no generic credential named "console-bot".',
      ],
      [
        { code: 1, stdout: "" },
        "Reading the Windows credential store failed (PowerShell exit code 1).",
      ],
      [
        { code: 0, stdout: clientSecret },
        "The answer of the credential store could not be read.",
      ],
    ])("reports a reader that answers %j", async (result, message) => {
      const { exitCode, document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: async () => result },
      );
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "credential-unavailable", message },
      ]);
      expect(seen).toHaveLength(0);
    });

    it("refuses a credential that is not a service token", async () => {
      const { document } = await client(
        ["check", "--credential", "console-bot"],
        {
          env: {},
          platform: "win32",
          runProcess: async () =>
            stored({ clientId: "someone", clientSecret: clientSecret }),
        },
      );
      expect(document.errors).toEqual([
        {
          code: "invalid-credentials",
          message:
            'The Client ID from the credential "console-bot" is not a service token Client ID (32 hexadecimal characters and ".access").',
        },
      ]);
      expect(seen).toHaveLength(0);
    });

    it("says that the store exists on Windows only", async () => {
      const { document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {} },
      );
      expect(document.errors).toEqual([
        {
          code: "credential-unavailable",
          message:
            "--credential reads the Windows credential store. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
        },
      ]);
    });
  });

  describe("when an error about the job names the stored Client ID", () => {
    it("is removed from the report", async () => {
      const reader = vi.fn(async () =>
        stored({ clientId, clientSecret: clientSecret }),
      );
      const { exitCode, document, logs } = await client(
        ["queue", `${clientId}.json`, "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(1);
      expect(reader).toHaveBeenCalledTimes(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(JSON.stringify(document)).not.toContain(clientId);
      expect(logs.join("\n")).not.toContain(clientId);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
    });
  });

  describe("when the environment has both variables", () => {
    it("does not read the store", async () => {
      const reader = vi.fn();
      const { exitCode } = await client(
        ["check", "--credential", "console-bot"],
        { platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(0);
      expect(reader).not.toHaveBeenCalled();
    });
  });
});

describe("runProcess", () => {
  describe("when the program runs", () => {
    it("returns its stdout and passes the extra environment", async () => {
      expect(
        await runProcess({
          file: process.execPath,
          args: ["-e", "process.stdout.write(process.env.PUBLISH_POST_TEST)"],
          env: { PUBLISH_POST_TEST: "from the environment" },
        }),
      ).toEqual({ code: 0, stdout: "from the environment" });
    });

    it("returns its exit code and none of its stderr", async () => {
      expect(
        await runProcess({
          file: process.execPath,
          args: ["-e", "console.error('noise'); process.exit(3)"],
          env: {},
        }),
      ).toEqual({ code: 3, stdout: "" });
    });
  });

  describe("when the program cannot be started", () => {
    it("returns a failure instead of throwing", async () => {
      expect(
        await runProcess({
          file: path.join(dir, "no-such-program"),
          args: [],
          env: {},
        }),
      ).toEqual({ code: -1, stdout: "" });
    });
  });
});

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
      seen = [];

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
      afterAnswer = (request) => {
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
      afterAnswer = () => {};
      env.CHANNELS_JSON = JSON.stringify([linkedin, instagram]);
      seen = [];
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

      seen = [];
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
      answer = (request) =>
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

describe("an upload that fails", () => {
  describe("when the Worker refuses the image", () => {
    it("reports it, sends no post for that channel and uploads again next time", async () => {
      const job = await writeJob();
      let uploads = 0;
      answer = (request) =>
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
      answer = (request) =>
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

describe("the state file", () => {
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
      seen = [];

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
      seen = [];

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
      seen = [];

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
      seen = [];

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
      seen = [];

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
      for (let index = 0; index < later.length; index += 2) {
        expect(later[index]).toBe(
          'write post.state.json.tmp {"flag":"w","flush":true}',
        );
        expect(later[index + 1]).toBe(
          "rename post.state.json.tmp -> post.state.json",
        );
      }
      expect(await readdir(dir)).not.toContain("post.state.json.tmp");
      expect((await readState()).channels.li1.step).toBe("created");
      expect(JSON.parse(await readFile(statePath, "utf8")).version).toBe(1);
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

        seen = [];
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
  });
});

describe("the secret", () => {
  const leaking = (failAt: string): typeof fetch => {
    return async (input, init) => {
      if ((input as URL).pathname === failAt)
        throw new TypeError(`Invalid header value ${clientSecret}`, {
          cause: new Error(`CF-Access-Client-Secret: ${clientSecret}`),
        });
      return localFetch(input, init);
    };
  };

  describe("when an error before the credentials are loaded names the Client ID", () => {
    it("is removed from the report all the same", async () => {
      const { exitCode, document, logs } = await client([
        "queue",
        `${clientId}.json`,
      ]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(document.errors[0].message).toMatch(/^Cannot read the job /);
      expect(JSON.stringify(document)).not.toContain(clientId);
      expect(logs.join("\n")).not.toContain(clientId);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
    });
  });

  describe("when a failed request names it", () => {
    it.each([
      ["/api/buffer/session"],
      ["/api/buffer/media"],
      ["/api/buffer/posts"],
    ])("is removed from the report of a failure at %s", async (failAt) => {
      const job = await writeJob({ channels: ["linkedin"] });
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fetch: leaking(failAt),
      });
      expect(exitCode).toBe(1);
      const report = JSON.stringify(document);
      expect(report).toContain(
        "Invalid header value [redacted] (CF-Access-Client-Secret: [redacted])",
      );
      expect(report).not.toContain(clientSecret);
      if (failAt !== "/api/buffer/session")
        expect(JSON.stringify(await readState())).toContain("[redacted]");
    });
  });

  describe("when the other side repeats it", () => {
    it.each([
      ["/api/buffer/session", 403],
      ["/api/buffer/media", 400],
      ["/api/buffer/posts", 403],
      ["/api/buffer/posts", 500],
    ])("is removed from the message of %s answering %i", async (failAt, status) => {
      const job = await writeJob({ channels: ["linkedin"] });
      answer = (request) =>
        request.path === failAt
          ? Response.json(
              {
                message: `Bad token ${request.headers["cf-access-client-secret"]} for ${request.headers["cf-access-client-id"]}`,
              },
              { status },
            )
          : undefined;
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(JSON.stringify(document)).toContain(
        "Bad token [redacted] for [redacted]",
      );
    });

    it.each([
      ["/api/buffer/media", 400],
      ["/api/buffer/posts", 403],
    ])("is removed whole when it lies across the length limit of a message of %s", async (failAt, status) => {
      const job = await writeJob({ channels: ["linkedin"] });
      // A message is cut at 500 characters: the secret starts ten before.
      const padding = "p".repeat(490);
      answer = (request) =>
        request.path === failAt
          ? Response.json(
              {
                message: `${padding}${request.headers["cf-access-client-secret"]} and ${request.headers["cf-access-client-id"]}`,
              },
              { status },
            )
          : undefined;
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      const report = JSON.stringify(document);
      const state = JSON.stringify(await readState());
      for (const text of [report, state]) {
        expect(text).toContain(`${padding}[redacted]`);
        expect(text).not.toContain(clientSecret.slice(0, 8));
        expect(text).not.toContain(clientId.slice(0, 8));
      }
    });

    it("is removed from a channel id that carries it", async () => {
      const job = await writeJob();
      answer = (request) =>
        request.path === "/api/buffer/session"
          ? Response.json({
              service: "gieniek-bot",
              channels: [
                {
                  id: String(request.headers["cf-access-client-secret"]),
                  name: "Echo",
                  service: "linkedin",
                },
              ],
            })
          : undefined;
      const { document, logs } = await client(["queue", job, "--send"]);
      expect(document.channels[0]).toMatchObject({
        id: "[redacted]",
        outcome: "refused",
        status: 403,
      });
      expect(logs).toEqual([
        "session: 200",
        "linkedin ([redacted]): upload 200",
        "linkedin ([redacted]): post 403",
      ]);
      expect(Object.keys((await readState()).channels)).toEqual(["[redacted]"]);
    });
  });

  describe("when something unforeseen throws with it", () => {
    it("is removed from the unexpected error and no stack is printed", async () => {
      const job = await writeJob();
      const { exitCode, document, logs } = await client(["queue", job], {
        newId: () => {
          throw new Error(`broken near ${clientSecret}`);
        },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "unexpected", message: "broken near [redacted]" },
      ]);
      expect(logs).toEqual(["session: 200"]);
    });

    it("reports a thrown value that is not an error", async () => {
      const job = await writeJob();
      const { document } = await client(["queue", job], {
        newId: () => {
          throw `id source failed for ${clientSecret}`;
        },
      });
      expect(document.errors).toEqual([
        { code: "unexpected", message: "id source failed for [redacted]" },
      ]);
    });
  });

  describe("when stderr is closed", () => {
    it("still reports what happened to the post", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const result = await run(["queue", job, "--send", "--url", origin], {
        env: credentials,
        fetch: localFetch,
        cwd: dir,
        log: () => {
          throw new Error("EPIPE");
        },
      });
      outputs.push(JSON.stringify(result.document));
      expect(result.exitCode).toBe(0);
      expect(result.document.channels[0].outcome).toBe("created");
    });
  });
});

describe("the command in its own process", () => {
  describe("when it checks the session", () => {
    it("prints one JSON document on stdout and the diagnostics on stderr", async () => {
      const { exitCode, stdout, stderr } = await spawnClient(
        ["check"],
        credentials,
      );
      expect(exitCode).toBe(0);
      const document = JSON.parse(stdout);
      expect(stdout).toBe(`${JSON.stringify(document, null, 2)}\n`);
      expect(document).toEqual({
        ok: true,
        command: "check",
        sent: false,
        url: origin,
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(stderr).toBe("session: 200\n");
    });
  });

  describe("when it queues a job twice", () => {
    it("creates the posts once", async () => {
      const job = await writeJob();
      const first = await spawnClient(["queue", job, "--send"], credentials);
      expect(first.exitCode).toBe(0);
      expect(outcomes(JSON.parse(first.stdout).channels)).toEqual({
        li1: "created",
        ig1: "created",
      });

      const second = await spawnClient(["queue", job, "--send"], credentials);
      expect(second.exitCode).toBe(0);
      expect(outcomes(JSON.parse(second.stdout).channels)).toEqual({
        li1: "already-created",
        ig1: "already-created",
      });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("when it fails", () => {
    it("exits with 1 and still prints the document, without the secret", async () => {
      const missing = await spawnClient(["check"], {});
      expect(missing.exitCode).toBe(1);
      expect(JSON.parse(missing.stdout).errors[0].code).toBe(
        "missing-credentials",
      );
      expect(missing.stderr).toBe("");

      const refused = await spawnClient(["check"], {
        ...credentials,
        CF_ACCESS_CLIENT_SECRET: `${clientSecret}0`,
      });
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout).errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
      expect(refused.stdout + refused.stderr).not.toContain(clientSecret);
      expect(seen).toHaveLength(1);
    });
  });
});
