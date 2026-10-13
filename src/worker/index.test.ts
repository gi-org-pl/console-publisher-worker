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

describe("Given the publishing restrictions for a service", () => {
  const hour = 3_600_000;
  const twoChannels = [
    { id: "allowed", name: "Our Instagram", service: "instagram" },
    { id: "second", name: "Our LinkedIn", service: "linkedin" },
  ];
  function scheduled(leadMs: number) {
    return {
      ...input,
      requestId: crypto.randomUUID(),
      mode: "customScheduled",
      dueAt: new Date(Date.now() + leadMs).toISOString(),
    };
  }
  function configure(service: Record<string, unknown>) {
    env.SERVICES_JSON = JSON.stringify([
      { clientId, name: "gieniek-bot", ...service },
    ]);
  }
  function denials() {
    return errorLog.mock.calls
      .map(([line]) => JSON.parse(line))
      .filter((line) => line.action === "service-post-denied");
  }
  beforeEach(asService);

  it("refuses immediate publishing with 403 and leaves a trace", async () => {
    const response = await sendAsService({ ...input, mode: "shareNow" });
    expect(response.status).toBe(403);
    expect(post).not.toHaveBeenCalled();
    expect(objects.has(`receipts/${requestId}`)).toBe(false);
    expect(denials()).toEqual([
      {
        action: "service-post-denied",
        requestId,
        channelId: "allowed",
        mode: "shareNow",
        actor: "service",
        service: "gieniek-bot",
        error: "Error: Mode not allowed for a service",
      },
    ]);
  });
  it("still lets a service use the queue", async () => {
    expect((await sendAsService()).status).toBe(200);
    expect(JSON.parse(post.mock.calls[0][1].body).variables.input.mode).toBe(
      "addToQueue",
    );
    expect(denials()).toEqual([]);
  });
  it("requires two hours of lead time for a scheduled post by default", async () => {
    const tooSoon = await sendAsService(scheduled(hour));
    expect(tooSoon.status).toBe(400);
    expect(await tooSoon.json()).toEqual({
      message: "Choose a time from 120 minutes to 30 days from now.",
    });
    expect(post).not.toHaveBeenCalled();
    expect(denials()).toMatchObject([
      { mode: "customScheduled", error: "Error: Schedule time not allowed" },
    ]);

    expect((await sendAsService(scheduled(3 * hour))).status).toBe(200);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("takes the lead time from the service's own configuration", async () => {
    configure({ minScheduleLeadMinutes: 240 });
    expect((await sendAsService(scheduled(3 * hour))).status).toBe(400);
    expect((await sendAsService(scheduled(5 * hour))).status).toBe(200);

    configure({ minScheduleLeadMinutes: 10 });
    expect((await sendAsService(scheduled(hour))).status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it("limits a service to its own channel allowlist", async () => {
    env.CHANNELS_JSON = JSON.stringify(twoChannels);
    configure({ channelIds: ["second", "not-in-channels-json"] });

    const session = await worker.fetch(
      serviceRequest("/api/buffer/session"),
      env,
    );
    expect(await session.json()).toEqual({
      service: "gieniek-bot",
      channels: [twoChannels[1]],
    });

    expect((await sendAsService()).status).toBe(403);
    expect(
      (await sendAsService({ ...input, channelId: "not-in-channels-json" }))
        .status,
    ).toBe(403);
    expect(post).not.toHaveBeenCalled();
    expect(denials()).toMatchObject([
      { channelId: "allowed", error: "Error: Channel not allowed" },
      { channelId: "not-in-channels-json" },
    ]);

    expect(
      (
        await sendAsService({
          ...input,
          requestId: crypto.randomUUID(),
          channelId: "second",
        })
      ).status,
    ).toBe(200);
  });
  it("gives a service every approved channel when it has no list of its own", async () => {
    env.CHANNELS_JSON = JSON.stringify(twoChannels);
    const session = await worker.fetch(
      serviceRequest("/api/buffer/session"),
      env,
    );
    expect(await session.json()).toMatchObject({ channels: twoChannels });
    expect(
      (await sendAsService({ ...input, channelId: "second" })).status,
    ).toBe(200);
  });
  it.each([
    { minScheduleLeadMinutes: 0 },
    { minScheduleLeadMinutes: 1.5 },
    { minScheduleLeadMinutes: 30 * 24 * 60 },
    { minScheduleLeadMinutes: "120" },
    { channelIds: [] },
    { channelIds: [""] },
    { modes: ["shareNow"] },
  ])("fails closed on an invalid restriction: %j", async (service) => {
    configure(service);
    expect((await sendAsService()).status).toBe(503);
    expect(post).not.toHaveBeenCalled();
  });
  it("records the service in the publication record and the log", async () => {
    expect((await sendAsService()).status).toBe(200);
    expect(
      JSON.parse(String(objects.get(`receipts/${requestId}`)?.value)),
    ).toMatchObject({
      owner: serviceOwner,
      service: "gieniek-bot",
      postId: "post1",
    });
    expect(JSON.parse(infoLog.mock.calls[0][0])).toMatchObject({
      action: "buffer-post-created",
      actor: "service",
      service: "gieniek-bot",
      requestId,
      channelId: "allowed",
    });
    expect(await (await sendAsService()).json()).toEqual({ postId: "post1" });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not apply any of the restrictions to an operator", async () => {
    env.CHANNELS_JSON = JSON.stringify(twoChannels);
    configure({ channelIds: ["second"], minScheduleLeadMinutes: 240 });
    authenticate.mockResolvedValue(user);
    objects.set(`images/${mediaId}`, {
      value: png(),
      customMetadata: { owner: "user1" },
    });

    const session = await worker.fetch(request("/api/buffer/session"), env);
    expect(await session.json()).toEqual({
      email: "operator@example.org",
      channels: twoChannels,
    });
    expect((await send({ ...input, mode: "shareNow" })).status).toBe(200);
    expect((await send(scheduled(5 * 60_000))).status).toBe(200);
    const tooSoon = await send(scheduled(1000));
    expect(await tooSoon.json()).toEqual({
      message: "Choose a time from one minute to 30 days from now.",
    });
    expect(
      JSON.parse(String(objects.get(`receipts/${requestId}`)?.value)),
    ).not.toHaveProperty("service");
    expect(denials()).toEqual([]);
  });
});

describe("Given a post with several images", () => {
  const images = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const { mediaId: _single, ...withoutImage } = input;
  const several = { ...withoutImage, mediaIds: images };
  const own = (ids: string[], owner = "user1") => {
    for (const id of ids)
      objects.set(`images/${id}`, { value: png(), customMetadata: { owner } });
  };
  const sentAssets = (call = 0) =>
    JSON.parse(post.mock.calls[call][1].body).variables.input.assets;
  const urls = (ids: string[]) =>
    ids.map((id) => ({ image: { url: `${origin}/buffer-media/${id}.png` } }));

  beforeEach(() => own(images));

  it("creates one Buffer post with one asset per image, in the order given", async () => {
    const order = [images[2], images[0], images[1]];
    expect(await (await send({ ...several, mediaIds: order })).json()).toEqual({
      postId: "post1",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(sentAssets()).toEqual(urls(order));
    expect(
      JSON.parse(post.mock.calls[0][1].body).variables.input.metadata,
    ).toEqual({ instagram: { type: "post", shouldShareToFeed: true } });
  });

  it("keeps taking the single image of a client that knows no list", async () => {
    expect((await send()).status).toBe(200);
    expect(sentAssets()).toEqual(urls([mediaId]));
  });

  it("takes a list of one image like the single image", async () => {
    expect((await send({ ...withoutImage, mediaIds: [mediaId] })).status).toBe(
      200,
    );
    expect(sentAssets()).toEqual(urls([mediaId]));
  });

  it.each([
    ["both a single image and a list", { ...several, mediaId }],
    ["neither", withoutImage],
    ["an empty list", { ...several, mediaIds: [] }],
    ["the same image twice", { ...several, mediaIds: [images[0], images[0]] }],
    ["an ID that is no UUID", { ...several, mediaIds: [images[0], "x"] }],
    [
      "more images than any network takes",
      {
        ...several,
        mediaIds: Array.from({ length: 21 }, () => crypto.randomUUID()),
      },
    ],
  ])("refuses %s with 400 before anything else", async (_name, body) => {
    expect((await send(body)).status).toBe(400);
    expect(post).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it.each([
    ["instagram", 10],
    ["facebook", 10],
    ["linkedin", 20],
    ["threads", 1],
    ["bluesky", 1],
  ])("lets %s have %i and refuses one more with 400", async (service, limit) => {
    env.CHANNELS_JSON = JSON.stringify([
      { id: "allowed", name: "Channel", service },
    ]);
    const ids = Array.from({ length: limit + 1 }, () => crypto.randomUUID());
    own(ids);

    if (limit < 20) {
      const refused = await send({ ...several, mediaIds: ids });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        message:
          limit === 1
            ? "This channel takes one image in a post."
            : `This channel takes at most ${limit} images in a post.`,
      });
      expect(post).not.toHaveBeenCalled();
    }

    const accepted = await send({
      ...several,
      requestId: crypto.randomUUID(),
      mediaIds: ids.slice(0, limit),
    });
    expect(accepted.status).toBe(200);
    expect(sentAssets()).toHaveLength(limit);
  });

  it.each([
    ["is missing", () => objects.delete(`images/${images[1]}`)],
    ["belongs to someone else", () => own([images[1]], "user2")],
  ])("refuses the whole post when one image %s, and Buffer is not called", async (_name, spoil) => {
    spoil();
    const response = await send(several);
    expect(response.status).toBe(403);
    expect(post).not.toHaveBeenCalled();
    expect(objects.has(`receipts/${requestId}`)).toBe(false);
  });

  it("returns the same post for a retry with the same list and 409 for a changed one", async () => {
    expect((await send(several)).status).toBe(200);
    expect(await (await send(several)).json()).toEqual({ postId: "post1" });
    expect(
      (await send({ ...several, mediaIds: [images[1], images[0], images[2]] }))
        .status,
    ).toBe(409);
    expect(
      (await send({ ...several, mediaIds: images.slice(0, 2) })).status,
    ).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("opens nothing new to a service: its own images only, and never at once", async () => {
    asService();
    expect((await sendAsService(several)).status).toBe(403);
    expect(post).not.toHaveBeenCalled();

    own(images, serviceOwner);
    expect((await sendAsService({ ...several, mode: "shareNow" })).status).toBe(
      403,
    );
    expect((await sendAsService(several)).status).toBe(200);
    expect(sentAssets()).toEqual(urls(images));
  });
});

describe("Given a story", () => {
  const { text: _caption, ...withoutText } = input;
  const story = { ...withoutText, type: "story" };
  const sent = (call = 0) =>
    JSON.parse(post.mock.calls[call][1].body).variables.input;
  const onChannel = (service: string) => {
    env.CHANNELS_JSON = JSON.stringify([
      { id: "allowed", name: "Channel", service },
    ]);
  };

  it("creates an Instagram story without a caption and keeps it out of the feed", async () => {
    expect(await (await send(story)).json()).toEqual({ postId: "post1" });
    expect(sent()).toMatchObject({
      mode: "addToQueue",
      schedulingType: "automatic",
      assets: [{ image: { url: `${origin}/buffer-media/${mediaId}.png` } }],
      metadata: { instagram: { type: "story", shouldShareToFeed: false } },
    });
    expect(sent()).not.toHaveProperty("text");
  });

  it("refuses a story for Facebook with 400 before anything is sent to Buffer, and keeps its feed posts", async () => {
    onChannel("facebook");
    const response = await send(story);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "This channel has no stories.",
    });
    expect(post).not.toHaveBeenCalled();
    expect(objects.has(`receipts/${requestId}`)).toBe(false);

    expect((await send()).status).toBe(200);
    expect(sent().metadata).toEqual({ facebook: { type: "post" } });
  });

  it("creates a feed post exactly as before when the type is left out or is post", async () => {
    expect((await send()).status).toBe(200);
    expect(
      (await send({ ...input, requestId: crypto.randomUUID(), type: "post" }))
        .status,
    ).toBe(200);
    for (const call of [0, 1]) {
      expect(sent(call)).toMatchObject({
        text: "Hello",
        metadata: { instagram: { type: "post", shouldShareToFeed: true } },
      });
    }
  });

  it("schedules a story like a post", async () => {
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (await send({ ...story, mode: "customScheduled", dueAt })).status,
    ).toBe(200);
    expect(sent()).toMatchObject({ mode: "customScheduled", dueAt });
  });

  it.each([
    "linkedin",
    "threads",
    "twitter",
  ])("refuses a story for %s with 400, and Buffer is not called", async (service) => {
    onChannel(service);
    const response = await send(story);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "This channel has no stories.",
    });
    expect(post).not.toHaveBeenCalled();
    expect(objects.has(`receipts/${requestId}`)).toBe(false);
  });

  it.each([
    ["a story with a caption", { ...story, text: "Hello" }],
    ["a story with an empty caption", { ...story, text: "" }],
    ["a post without a text", withoutText],
    ["a post without a text, named as one", { ...withoutText, type: "post" }],
    ["a type that is not known", { ...input, type: "reel" }],
  ])("refuses %s with 400 before anything else", async (_name, body) => {
    expect((await send(body)).status).toBe(400);
    expect(post).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it("takes one image only", async () => {
    const second = "11111111-1111-4111-8111-111111111111";
    objects.set(`images/${second}`, {
      value: png(),
      customMetadata: { owner: "user1" },
    });
    const { mediaId: _single, ...withoutImage } = story;

    const response = await send({
      ...withoutImage,
      mediaIds: [mediaId, second],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "A story takes one image.",
    });
    expect(post).not.toHaveBeenCalled();

    expect(
      (
        await send({
          ...withoutImage,
          requestId: crypto.randomUUID(),
          mediaIds: [mediaId],
        })
      ).status,
    ).toBe(200);
  });

  it("returns the same story for a retry and 409 when the request turns into a post", async () => {
    expect((await send(story)).status).toBe(200);
    expect(await (await send(story)).json()).toEqual({ postId: "post1" });
    expect((await send(input)).status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });

  describe("from a service", () => {
    const configure = (service: Record<string, unknown> = {}) => {
      env.SERVICES_JSON = JSON.stringify([
        { clientId, name: "gieniek-bot", ...service },
      ]);
    };
    beforeEach(() => {
      asService();
      onChannel("instagram");
    });

    it("is accepted, queued like a post", async () => {
      const response = await sendAsService(story);
      expect(response.status).toBe(200);
      expect(sent()).toMatchObject({ mode: "addToQueue" });
    });

    it("keeps the restrictions of a service: no immediate publishing", async () => {
      expect((await sendAsService({ ...story, mode: "shareNow" })).status).toBe(
        403,
      );
      expect(post).not.toHaveBeenCalled();
    });

    it("keeps the lead time of a service", async () => {
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
      const scheduled = { ...story, mode: "customScheduled" };
      expect((await sendAsService({ ...scheduled, dueAt: soon })).status).toBe(
        400,
      );
      expect((await sendAsService({ ...scheduled, dueAt: later })).status).toBe(
        200,
      );
    });

    it("keeps the channel list of a service", async () => {
      configure({ channelIds: ["elsewhere"] });
      expect((await sendAsService(story)).status).toBe(403);
      expect(post).not.toHaveBeenCalled();
    });
  });
});
