import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { R2Bucket } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import worker, { type Env } from "../../../src/worker/index";
import type { Report } from "../report.mjs";
import { run } from "../run.mjs";

// What the tests of the whole client share. The client runs here against the
// Worker's own code, served on 127.0.0.1. Access, R2 and Buffer are stand-ins;
// nothing leaves the machine. A test file calls `useWorkerStandIn()` once.

const { clientId, clientSecret } = vi.hoisted(() => ({
  clientId: "e367826f93b8d71185e03fe518aff3b4.access",
  clientSecret:
    "f00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dface",
}));
export { clientId, clientSecret };
vi.mock("../../../src/worker/auth", () => ({
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

export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export type ChannelResult = Report["channels"][number];

const realFetch = globalThis.fetch;
const script = fileURLToPath(new URL("../../publishPost.mjs", import.meta.url));
export const linkedin = {
  id: "li1",
  name: "Foundation LinkedIn",
  service: "linkedin",
};
export const instagram = {
  id: "ig1",
  name: "Foundation Instagram",
  service: "instagram",
};
export const credentials = {
  CF_ACCESS_CLIENT_ID: clientId,
  CF_ACCESS_CLIENT_SECRET: clientSecret,
};

let server: Server;
export let origin: string;
export let env: Env;
export let dir: string;
export let seen: Seen[];
/** What a test may put in the way of the Worker. Both are reset before each test. */
export const standIn: {
  /** Answers in place of the Worker when it returns a response. */
  answer: (request: Seen) => Response | undefined;
  /** Runs after the Worker answered, to change its configuration mid-run. */
  afterAnswer: (request: Seen) => void;
} = { answer: () => undefined, afterAnswer: () => {} };
export let bufferFetch: ReturnType<typeof vi.fn>;
export let objects: Map<
  string,
  { value: unknown; customMetadata?: Record<string, string> }
>;
/** Everything the client printed or returned, checked for the secret afterwards. */
export let outputs: string[];

export function png(width = 1080, height = 1080) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** Only this machine's stand-in may be reached from a test. */
export const localFetch: typeof fetch = (input, init) => {
  if (!String(input).startsWith(`${origin}/`))
    throw new Error(`A test tried to reach ${String(input)}`);
  return realFetch(input, init);
};

export async function client(
  argv: string[],
  overrides: Record<string, unknown> = {},
) {
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
export function spawnClient(argv: string[], extraEnv: Record<string, string>) {
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

export async function writeJob(
  job: Record<string, unknown> = {},
  name = "post.json",
) {
  await writeFile(path.join(dir, "post.png"), png());
  await writeFile(
    path.join(dir, name),
    JSON.stringify({ text: "Hello from the job", image: "post.png", ...job }),
  );
  return name;
}

export async function readState(name = "post.state.json") {
  return JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
    version: number;
    targets: string[] | null;
    channels: Record<
      string,
      {
        service?: string;
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

export function count() {
  const paths = seen.map((request) => request.path);
  return {
    session: paths.filter((item) => item === "/api/buffer/session").length,
    media: paths.filter((item) => item === "/api/buffer/media").length,
    posts: paths.filter((item) => item === "/api/buffer/posts").length,
  };
}

/** What Buffer was asked to create. */
export function bufferPosts() {
  return bufferFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).variables.input,
  );
}

export function outcomes(channels: ChannelResult[]) {
  return Object.fromEntries(
    channels.map((channel) => [channel.id, channel.outcome]),
  );
}

/** A time the given number of minutes from now, written with a +02:00 offset. */
export function inMinutes(minutes: number) {
  return new Date(Date.now() + (minutes + 120) * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+02:00");
}

/** Starts the stand-in for the tests of a file and checks every test for the secret. */
export function useWorkerStandIn() {
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
        standIn.answer(request) ??
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
      standIn.afterAnswer(request);
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
    standIn.answer = () => undefined;
    standIn.afterAnswer = () => {};
    let posts = 0;
    bufferFetch = vi.fn(async () =>
      Response.json({
        data: { createPost: { post: { id: `post${++posts}` } } },
      }),
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
}
