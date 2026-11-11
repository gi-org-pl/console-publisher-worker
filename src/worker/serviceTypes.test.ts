// @vitest-environment node
import type { R2Bucket } from "@cloudflare/workers-types";
import { expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { clock } from "./writeGap";

// A type that is not in `SERVICE_POST_TYPES` stays with people. Every type is
// listed today, so this file narrows the list to posts and checks that a
// service is refused a reel while an operator is not.

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./auth", () => ({ authenticate }));
vi.mock("../schemas/publishing", async (original) => ({
  ...(await original<typeof import("../schemas/publishing")>()),
  SERVICE_POST_TYPES: ["post"],
}));

const origin = "https://console.example.org";
const clientId = "e367826f93b8d71185e03fe518aff3b4.access";
const videoId = "44444444-4444-4444-8444-444444444444";

function setUp(owner: string) {
  const objects = new Map<string, unknown>([
    [`images/${videoId}.mp4`, { customMetadata: { owner } }],
  ]);
  const env = {
    APP_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    BUFFER_API_KEY: "buffer-key",
    CHANNELS_JSON: JSON.stringify([
      { id: "ig", name: "Instagram", service: "instagram" },
    ]),
    SERVICES_JSON: JSON.stringify([{ clientId, name: "gieniek-bot" }]),
    MEDIA: {
      head: async (key: string) => objects.get(key) ?? null,
      get: async () => null,
      put: async (key: string, value: unknown) => {
        objects.set(key, value);
        return { key };
      },
    } as unknown as R2Bucket,
  } satisfies Env;
  const buffer = vi.fn(async () =>
    Response.json({ data: { createPost: { post: { id: "post1" } } } }),
  );
  vi.stubGlobal("fetch", buffer);
  vi.spyOn(console, "info").mockImplementation(() => {});
  // The pause between the two writes of a receipt takes no time here.
  vi.spyOn(clock, "sleep").mockResolvedValue(undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return { env, buffer, errors };
}

function sendReel(env: Env, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${origin}/api/buffer/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        videoId,
        channelId: "ig",
        text: "Hello",
        type: "reel",
        mode: "addToQueue",
      }),
    }),
    env,
  );
}

it("refuses a service a type that is not listed with 403, and leaves a trace", async () => {
  authenticate.mockResolvedValue({ kind: "service", clientId });
  const { env, buffer, errors } = setUp(`service:${clientId}`);
  const response = await sendReel(env);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    message: "A service may not create a reel.",
  });
  expect(buffer).not.toHaveBeenCalled();
  expect(JSON.parse(errors.mock.calls[0][0])).toMatchObject({
    action: "service-post-denied",
    error: "Error: Post type not allowed for a service",
  });
});

it("lets an operator create the same type", async () => {
  authenticate.mockResolvedValue({
    kind: "user",
    email: "operator@example.org",
    subject: "user1",
  });
  const { env, buffer } = setUp("user1");
  const response = await sendReel(env, { Origin: origin });
  expect(response.status).toBe(200);
  expect(buffer).toHaveBeenCalledTimes(1);
});
