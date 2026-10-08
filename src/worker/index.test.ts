// @vitest-environment node
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { sessionSchema } from "../schemas/publishing";
import worker, { type Env } from "./index";

const { authenticate, post } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./auth", () => ({ authenticate }));
const origin = "https://console.example.org";
const mediaId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5de";
const requestId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df";
const input = {
  mediaId,
  requestId,
  channelId: "allowed",
  text: "Hello",
  mode: "addToQueue",
};
const clientId = "e367826f93b8d71185e03fe518aff3b4.access";
const serviceOwner = `service:${clientId}`;
const user = {
  kind: "user",
  email: "operator@example.org",
  subject: "user1",
};
let env: Env;
let errorLog: MockInstance<typeof console.error>;
let infoLog: MockInstance<typeof console.info>;
let failReceiptWrite: boolean;
let objects: Map<
  string,
  { value: unknown; customMetadata?: Record<string, string> }
>;

function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function send(body: unknown = input) {
  return worker.fetch(request("/api/buffer/posts", body), env);
}
/** A non-browser client: no Origin header unless one is given. */
function serviceRequest(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function sendAsService(body: unknown = input) {
  return worker.fetch(serviceRequest("/api/buffer/posts", body), env);
}
function asService() {
  authenticate.mockResolvedValue({ kind: "service", clientId });
  objects.set(`images/${mediaId}`, {
    value: png(),
    customMetadata: { owner: serviceOwner },
  });
}
function png() {
  const data = new Uint8Array(24);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  data.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(data.buffer).setUint32(16, 1080);
  new DataView(data.buffer).setUint32(20, 1080);
  return data;
}
function upload(body: Uint8Array = png(), contentType = "image/png") {
  return worker.fetch(
    new Request(`${origin}/api/buffer/media`, {
      method: "POST",
      body: body as BodyInit,
      headers: { Origin: origin, "Content-Type": contentType },
    }),
    env,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  failReceiptWrite = false;
  authenticate.mockResolvedValue(user);
  post.mockImplementation(async () =>
    Response.json({ data: { createPost: { post: { id: "post1" } } } }),
  );
  vi.stubGlobal("fetch", post);
  objects = new Map([
    [`images/${mediaId}`, { value: png(), customMetadata: { owner: "user1" } }],
  ]);
  env = {
    APP_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    BUFFER_API_KEY: "secret-key",
    CHANNELS_JSON: JSON.stringify([
      { id: "allowed", name: "Our Instagram", service: "instagram" },
    ]),
    SERVICES_JSON: JSON.stringify([{ clientId, name: "gieniek-bot" }]),
    MEDIA: {
      head: vi.fn(async (key: string) => objects.get(key) ?? null),
      get: vi.fn(async (key: string) => {
        const object = objects.get(key);
        return object
          ? {
              body: object.value,
              json: async () => JSON.parse(String(object.value)),
            }
          : null;
      }),
      put: vi.fn(
        async (
          key: string,
          value: unknown,
          options?: {
            onlyIf?: unknown;
            customMetadata?: Record<string, string>;
          },
        ) => {
          if (options?.onlyIf && objects.has(key)) return null;
          if (
            failReceiptWrite &&
            !options?.onlyIf &&
            key.startsWith("receipts/")
          )
            throw new Error("R2 unavailable");
          objects.set(key, { value, customMetadata: options?.customMetadata });
          return { key };
        },
      ),
    } as unknown as R2Bucket,
  };
});

describe("Given the publishing Worker", () => {
  it("rejects untrusted hosts before authentication", async () => {
    expect(
      (
        await worker.fetch(
          new Request("https://other.example/api/buffer/session"),
          env,
        )
      ).status,
    ).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated API requests", async () => {
    authenticate.mockRejectedValue(new Error("forged JWT"));
    for (const path of [
      "/api/buffer/session",
      "/api/buffer/posts",
      "/api/buffer/login",
    ]) {
      expect((await worker.fetch(request(path), env)).status).toBe(401);
    }
    expect(post).not.toHaveBeenCalled();
  });
  it("returns allowed channels without exposing the key", async () => {
    const response = await worker.fetch(request("/api/buffer/session"), env);
    const session = await response.json();
    expect(session).toEqual({
      email: "operator@example.org",
      channels: JSON.parse(env.CHANNELS_JSON),
    });
    expect(sessionSchema.safeParse(session).success).toBe(true);
  });
  it("redirects only a valid login state back to the Console", async () => {
    const state = crypto.randomUUID();
    const response = await worker.fetch(
      request(`/api/buffer/login?state=${state}`),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `${origin}/buffer-auth#${state}`,
    );
    expect(
      (await worker.fetch(request("/api/buffer/login?state=bad"), env)).status,
    ).toBe(400);
  });
  it("serves only known media without authentication", async () => {
    authenticate.mockRejectedValue(new Error("no login"));
    const response = await worker.fetch(
      request(`/buffer-media/${mediaId}.png`),
      env,
    );
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/buffer-media/${mediaId}.png`, {
            method: "HEAD",
          }),
          env,
        )
      ).body,
    ).toBeNull();
    expect(
      (await worker.fetch(request(`/buffer-media/${requestId}.png`), env))
        .status,
    ).toBe(404);
    expect(
      (await worker.fetch(request(`/buffer-media/${mediaId}.png`, {}), env))
        .status,
    ).toBe(405);
  });
  it("rejects cross-origin writes and unsupported methods", async () => {
    expect(
      (
        await worker.fetch(
          request("/api/buffer/posts", input, {
            Origin: "https://evil.example",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect((await worker.fetch(request("/api/buffer/posts"), env)).status).toBe(
      405,
    );
    expect((await worker.fetch(request("/other", {}), env)).status).toBe(404);
    expect(
      (await worker.fetch(request("/api/buffer/unknown", {}), env)).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          request("/api/buffer/posts", input, { "Content-Type": "text/plain" }),
          env,
        )
      ).status,
    ).toBe(415);
    expect(post).not.toHaveBeenCalled();
  });
  it("fails closed when configuration is missing", async () => {
    env.BUFFER_API_KEY = "";
    expect((await send()).status).toBe(503);
    env.CHANNELS_JSON = "invalid";
    expect(
      (await worker.fetch(request("/api/buffer/session"), env)).status,
    ).toBe(503);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"action":"request-failed"'),
    );
  });
  it("uploads PNGs with an owner and rejects invalid files", async () => {
    const response = await upload();
    const { mediaId: uploaded } = (await response.json()) as {
      mediaId: string;
    };
    expect(objects.get(`images/${uploaded}`)?.customMetadata).toEqual({
      owner: "user1",
    });
    expect((await upload(png(), "image/svg+xml")).status).toBe(415);
    expect((await upload(new Uint8Array(24))).status).toBe(400);
    const oversized = png();
    new DataView(oversized.buffer).setUint32(16, 5000);
    expect((await upload(oversized)).status).toBe(400);
    expect((await upload(new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(
      413,
    );
  });
  it("enforces the streamed limit and declared length, and requires a body", async () => {
    const response = await worker.fetch(
      new Request(`${origin}/api/buffer/media`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "image/png",
          "Content-Length": "99999999",
        },
        body: png(),
      }),
      env,
    );
    expect(response.status).toBe(413);
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/api/buffer/media`, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "image/png" },
          }),
          env,
        )
      ).status,
    ).toBe(400);
  });
  it.each([
    { ...input, channelId: "forbidden" },
    { ...input, mediaId: requestId },
  ])("rejects unauthorized channel or media: %j", async (body) => {
    expect((await send(body)).status).toBe(403);
    expect(post).not.toHaveBeenCalled();
  });
  it("rejects images owned by another operator", async () => {
    authenticate.mockResolvedValue({
      kind: "user",
      subject: "user2",
      email: "other@example.org",
    });
    expect((await send()).status).toBe(403);
  });
  it.each([
    { ...input, text: "" },
    { ...input, text: "x".repeat(25_000) },
    { ...input, mode: "customScheduled" },
    { ...input, mode: "customScheduled", dueAt: "2020-01-01T00:00:00.000Z" },
    { ...input, dueAt: "2030-01-01T00:00:00.000Z" },
    { ...input, mode: "customScheduled", dueAt: "2030-01-01T00:00:00.000Z" },
  ])("rejects invalid input: %j", async (body) => {
    expect((await send(body)).status).toBe(400);
  });
  it("creates a post using server-owned credentials, URL and Instagram metadata", async () => {
    expect(await (await send()).json()).toEqual({ postId: "post1" });
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining('"actor":"user","email":"operator@example.org"'),
    );
    const [endpoint, options] = post.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(endpoint).toBe("https://api.buffer.com");
    expect(options.headers.Authorization).toBe("Bearer secret-key");
    expect(body.variables.input).toMatchObject({
      mode: "addToQueue",
      schedulingType: "automatic",
      needsApproval: false,
      assets: [{ image: { url: `${origin}/buffer-media/${mediaId}.png` } }],
      metadata: { instagram: { type: "post", shouldShareToFeed: true } },
    });
  });
  it("sends the post type Buffer requires for Facebook", async () => {
    env.CHANNELS_JSON = JSON.stringify([
      { id: "allowed", name: "Facebook", service: "facebook" },
    ]);
    expect((await send()).status).toBe(200);
    expect(
      JSON.parse(post.mock.calls[0][1].body).variables.input.metadata,
    ).toEqual({ facebook: { type: "post" } });
  });
  it("supports immediate and scheduled delivery without Instagram metadata on other channels", async () => {
    env.CHANNELS_JSON = JSON.stringify([
      { id: "allowed", name: "LinkedIn", service: "linkedin" },
    ]);
    expect((await send({ ...input, mode: "shareNow" })).status).toBe(200);
    expect(
      JSON.parse(post.mock.calls[0][1].body).variables.input.metadata,
    ).toBeUndefined();
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (
        await send({
          ...input,
          requestId: crypto.randomUUID(),
          mode: "customScheduled",
          dueAt,
        })
      ).status,
    ).toBe(200);
    expect(JSON.parse(post.mock.calls[1][1].body).variables.input.dueAt).toBe(
      dueAt,
    );
  });
  it("returns the receipt for identical retries and rejects changed content", async () => {
    await send();
    expect(await (await send()).json()).toEqual({ postId: "post1" });
    expect((await send({ ...input, text: "different" })).status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("reserves concurrent requests atomically", async () => {
    const results = await Promise.all([send(), send()]);
    expect(results.map((response) => response.status)).toContain(200);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it.each([
    { errors: [{ message: "secret internal error" }] },
    { data: { createPost: { message: "limit reached" } } },
    { data: { createPost: null } },
    "not JSON",
  ])("handles GraphQL and invalid responses without retrying: %j", async (response) => {
    post.mockResolvedValue(Response.json(response));
    expect((await send()).status).toBe(502);
    expect((await send()).status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"action":"buffer-post-unconfirmed"'),
    );
  });
  it("never retries ambiguous timeouts or exposes upstream errors", async () => {
    post.mockRejectedValue(new Error("secret-key"));
    const response = await send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-key");
    expect((await send()).status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not treat a failed HTTP response as a created post", async () => {
    post.mockResolvedValue(
      Response.json({ message: "failure" }, { status: 500 }),
    );
    expect((await send()).status).toBe(502);
    expect((await send()).status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("reports a created post even when its receipt cannot be saved", async () => {
    failReceiptWrite = true;
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ postId: "post1" });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"action":"receipt-write-failed"'),
    );
  });
});

describe("Given a Cloudflare Access service token", () => {
  beforeEach(asService);

  it("identifies an allowlisted service in its session", async () => {
    const response = await worker.fetch(
      serviceRequest("/api/buffer/session"),
      env,
    );
    const session = await response.json();
    expect(session).toEqual({
      service: "gieniek-bot",
      channels: JSON.parse(env.CHANNELS_JSON),
    });
    expect(sessionSchema.safeParse(session).success).toBe(true);
    expect(
      sessionSchema.safeParse({ ...session, email: "operator@example.org" })
        .success,
    ).toBe(false);
  });
  it.each([
    JSON.stringify([
      { clientId: clientId.replace("e3", "aa"), name: "other-bot" },
    ]),
    "[]",
    "",
    undefined,
  ])("rejects a service token that is not on the allowlist: %j", async (services) => {
    env.SERVICES_JSON = services;
    for (const response of [
      await worker.fetch(serviceRequest("/api/buffer/session"), env),
      await sendAsService(),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(post).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `"action":"service-denied","path":"/api/buffer/session","kind":"service","clientId":"${clientId}"`,
      ),
    );
  });
  it.each([
    "invalid",
    JSON.stringify([{ clientId: "gieniek-bot", name: "gieniek-bot" }]),
    JSON.stringify([{ clientId, name: "Gieniek Bot" }]),
    JSON.stringify([{ clientId, name: "gieniek-bot", admin: true }]),
  ])("fails closed for services on an invalid allowlist without locking the operator out: %j", async (services) => {
    env.SERVICES_JSON = services;
    expect((await sendAsService()).status).toBe(503);
    expect(post).not.toHaveBeenCalled();

    authenticate.mockResolvedValue(user);
    expect(
      (await worker.fetch(request("/api/buffer/session"), env)).status,
    ).toBe(200);
  });
  it("does not offer the browser login redirect to a service", async () => {
    expect(
      (
        await worker.fetch(
          serviceRequest(`/api/buffer/login?state=${crypto.randomUUID()}`),
          env,
        )
      ).status,
    ).toBe(403);
  });
  it("accepts writes without an Origin header but still rejects a foreign one", async () => {
    expect((await sendAsService()).status).toBe(200);
    expect(
      (
        await worker.fetch(
          serviceRequest(
            "/api/buffer/posts",
            { ...input, requestId: crypto.randomUUID() },
            { Origin: "https://evil.example" },
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          serviceRequest(
            "/api/buffer/posts",
            { ...input, requestId: crypto.randomUUID() },
            { Origin: origin },
          ),
          env,
        )
      ).status,
    ).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it("keeps requiring the Console origin from an operator", async () => {
    authenticate.mockResolvedValue(user);
    objects.set(`images/${mediaId}`, {
      value: png(),
      customMetadata: { owner: "user1" },
    });
    expect((await sendAsService()).status).toBe(403);
    expect(post).not.toHaveBeenCalled();
  });
  it("keeps service uploads and operator uploads apart", async () => {
    const response = await worker.fetch(
      new Request(`${origin}/api/buffer/media`, {
        method: "POST",
        body: png() as BodyInit,
        headers: { "Content-Type": "image/png" },
      }),
      env,
    );
    const { mediaId: uploaded } = (await response.json()) as {
      mediaId: string;
    };
    expect(objects.get(`images/${uploaded}`)?.customMetadata).toEqual({
      owner: serviceOwner,
    });

    authenticate.mockResolvedValue(user);
    expect((await send({ ...input, mediaId: uploaded })).status).toBe(403);

    authenticate.mockResolvedValue({ kind: "service", clientId });
    objects.set(`images/${mediaId}`, {
      value: png(),
      customMetadata: { owner: "user1" },
    });
    expect((await sendAsService()).status).toBe(403);
    expect(post).not.toHaveBeenCalled();
  });
  it("logs a service call under the service name, not an email", async () => {
    expect(await (await sendAsService()).json()).toEqual({ postId: "post1" });
    const line = JSON.parse(infoLog.mock.calls[0][0]);
    expect(line).toMatchObject({
      action: "buffer-post-created",
      actor: "service",
      service: "gieniek-bot",
      postId: "post1",
    });
    expect(line).not.toHaveProperty("email");
    expect(
      JSON.parse(String(objects.get(`receipts/${requestId}`)?.value)),
    ).toMatchObject({ owner: serviceOwner, postId: "post1" });
  });
});
