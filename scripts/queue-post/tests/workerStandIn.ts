import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { R2Bucket } from "@cloudflare/workers-types";
import { afterEach, beforeEach, expect, vi } from "vitest";
import worker, { type Env } from "../../../src/worker/index";
import { run } from "../../queuePost.mjs";

// What the tests of the whole script share. The script runs here against the
// Worker's own code: its requests go
// straight into `worker.fetch`. Access, R2 and Buffer are stand-ins; nothing
// leaves the machine. A test file calls `useWorkerStandIn()` once.

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

export const origin = "https://console.gi.org.pl";
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
export const token = {
  CF_ACCESS_CLIENT_ID: clientId,
  CF_ACCESS_CLIENT_SECRET: clientSecret,
};

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}
export type Channel = Record<string, unknown>;

export let env: Env;
export let dir: string;
export let seen: Seen[];
/** What a test may put in the way of the Worker. Reset before each test. */
export const standIn: {
  /** Answers in place of the Worker when it returns a response. */
  answer: (request: Seen) => Response | undefined;
} = { answer: () => undefined };
export let bufferFetch: ReturnType<typeof vi.fn>;
/** Everything the script returned, checked for the secret afterwards. */
let outputs: string[];

export function png(size = 24) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, 1080);
  new DataView(bytes.buffer).setUint32(20, 1080);
  return bytes;
}

/** The script's `fetch`: the Worker itself, or what a test puts in its place. */
export const viaWorker: typeof fetch = async (input, init) => {
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
    standIn.answer(request) ??
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

export async function script(
  argv: string[],
  overrides: Record<string, unknown> = {},
) {
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

export async function writeJob(
  job: Record<string, unknown> = {},
  name = "post.json",
) {
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

export const count = (route: string) =>
  seen.filter((request) => request.path === `/api/buffer/${route}`).length;
/** What Buffer was asked to create. */
export const bufferPosts = () =>
  bufferFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).variables.input,
  );

/** Starts the stand-in for the tests of a file and checks every test for the token. */
export function useWorkerStandIn() {
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    dir = await mkdtemp(path.join(os.tmpdir(), "queue-post-"));
    seen = [];
    outputs = [];
    standIn.answer = () => undefined;
    let posts = 0;
    bufferFetch = vi.fn(async () =>
      Response.json({
        data: { createPost: { post: { id: `post${++posts}` } } },
      }),
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
}
