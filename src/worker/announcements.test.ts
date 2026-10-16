// @vitest-environment node
import type { R2Bucket, ScheduledController } from "@cloudflare/workers-types";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { runAnnouncements } from "./cron";
import worker, { type Env } from "./index";

// Discord announcements end to end: a service queues posts and registers an
// announcement through the Worker's own routes, then the scheduled run asks
// Buffer about the posts and posts to Discord. Access, R2, Buffer and Discord
// are stand-ins; nothing leaves the machine.

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./auth", () => ({ authenticate }));

const origin = "https://console.example.org";
const clientId = "e367826f93b8d71185e03fe518aff3b4.access";
const otherClientId = "0123456789abcdef0123456789abcdef.access";
const webhook =
  "https://discord.com/api/webhooks/123456789012345678/Secret-Webhook_Token";
const user = { kind: "user", email: "operator@example.org", subject: "user1" };
const service = { kind: "service", clientId };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Stored {
  value: unknown;
  etag: string;
  customMetadata?: Record<string, string>;
}
type BufferAnswer = () => Response | Promise<Response>;

let env: Env;
let objects: Map<string, Stored>;
let version: number;
let listPageSize: number;
let errorLog: MockInstance<typeof console.error>;
let infoLog: MockInstance<typeof console.info>;
let fetchMock: ReturnType<typeof vi.fn>;
/** The `dueAt` Buffer gives the next post it creates. */
let nextDueAt: string | null;
let createdPosts: number;
/** What Buffer answers when asked about a post, by post ID. */
let bufferPosts: Map<string, BufferAnswer>;
let discordAnswer: () => Response | Promise<Response>;
let discordForms: FormData[];
let discordUrls: string[];
/** The pauses the run asked for, in milliseconds. */
let waits: number[];
/** Makes one R2 write throw, as R2 does above one write a second to a key. */
let failPut: ((key: string, value: unknown) => boolean) | undefined;

function runCron(now?: number) {
  return runAnnouncements(env, now, async (ms) => {
    waits.push(ms);
  });
}

function png(width = 1200, height = 630) {
  const data = new Uint8Array(24);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  data.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(data.buffer).setUint32(16, width);
  new DataView(data.buffer).setUint32(20, height);
  return data;
}

function call(path: string, body: unknown, headers: Record<string, string>) {
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers,
      body:
        body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
    }),
    env,
  );
}
function headersOf(type: string) {
  return { "Content-Type": type };
}
async function uploadImage(bytes = png()): Promise<string> {
  const response = await call("/api/buffer/media", bytes, {
    ...headersOf("image/png"),
    ...currentOrigin(),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { mediaId: string }).mediaId;
}
let caller: "service" | "user";
/** A service sends no Origin; an operator's browser always does. */
function currentOrigin(): Record<string, string> {
  return caller === "user" ? { Origin: origin } : {};
}
function as(who: "service" | "user") {
  caller = who;
  authenticate.mockResolvedValue(who === "user" ? user : service);
}

/** Queues one post per channel and returns the request IDs it used. */
async function queuePosts(channelIds = ["li", "fb"]): Promise<string[]> {
  const mediaId = await uploadImage();
  const requestIds: string[] = [];
  for (const channelId of channelIds) {
    const requestId = crypto.randomUUID();
    const response = await call(
      "/api/buffer/posts",
      {
        requestId,
        mediaId,
        channelId,
        text: "The full post",
        mode: "addToQueue",
      },
      { ...headersOf("application/json"), ...currentOrigin() },
    );
    expect(response.status).toBe(200);
    requestIds.push(requestId);
  }
  return requestIds;
}

function register(body: unknown) {
  return call("/api/buffer/announcements", body, {
    ...headersOf("application/json"),
    ...currentOrigin(),
  });
}

/** Queues posts and registers an announcement for them, as the service. */
async function announce(changes: Record<string, unknown> = {}) {
  const postRequestIds = await queuePosts();
  const mediaIds = [await uploadImage()];
  const body = {
    requestId: crypto.randomUUID(),
    text: "Short version for Discord. https://gi.org.pl",
    mediaIds,
    postRequestIds,
    ...changes,
  };
  const response = await register(body);
  return { body, response };
}

function stored(id: string) {
  const object = objects.get(`announcements/${id}.json`);
  return (
    object && {
      ...JSON.parse(String(object.value)),
      metadataStatus: object.customMetadata?.status,
    }
  );
}

function postStatus(status: string, dueAt: string | null = null): BufferAnswer {
  return () =>
    Response.json({
      data: { post: { id: "x", status, dueAt, sentAt: null } },
    });
}
const notFound: BufferAnswer = () =>
  Response.json({
    data: null,
    errors: [{ message: "Post not found", extensions: { code: "NOT_FOUND" } }],
  });

function bufferQueries() {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url) === "https://api.buffer.com" &&
      JSON.parse(init.body).query.includes("query Post"),
  );
}
function logged(log: MockInstance<(...args: unknown[]) => void>) {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)));
}
const at = (offset: number) => Date.now() + offset;

beforeEach(() => {
  vi.resetAllMocks();
  infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  as("service");
  objects = new Map();
  version = 0;
  listPageSize = 1000;
  nextDueAt = new Date(at(HOUR)).toISOString();
  createdPosts = 0;
  bufferPosts = new Map();
  discordForms = [];
  discordUrls = [];
  waits = [];
  failPut = undefined;
  discordAnswer = () => Response.json({ id: "message1" });
  fetchMock = vi.fn(async (input: unknown, init: RequestInit) => {
    const url = String(input);
    if (url === "https://api.buffer.com") {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("createPost")) {
        createdPosts += 1;
        return Response.json({
          data: {
            createPost: {
              post: {
                id: `post${createdPosts}`,
                dueAt: nextDueAt,
                status: "scheduled",
              },
            },
          },
        });
      }
      const answer =
        bufferPosts.get(body.variables.input.id) ?? postStatus("scheduled");
      return answer();
    }
    if (url.startsWith("https://discord.com/api/webhooks/")) {
      discordUrls.push(url);
      discordForms.push(init.body as FormData);
      return discordAnswer();
    }
    throw new Error(`A test tried to reach ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  env = {
    APP_ORIGIN: origin,
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    BUFFER_API_KEY: "buffer-key",
    DISCORD_ANNOUNCE_WEBHOOK_URL: webhook,
    CHANNELS_JSON: JSON.stringify([
      { id: "li", name: "LinkedIn", service: "linkedin" },
      { id: "fb", name: "Facebook", service: "facebook" },
    ]),
    SERVICES_JSON: JSON.stringify([{ clientId, name: "gieniek-bot" }]),
    MEDIA: {
      head: async (key: string) => objects.get(key) ?? null,
      get: async (key: string) => {
        const object = objects.get(key);
        return object
          ? {
              etag: object.etag,
              json: async () => JSON.parse(String(object.value)),
              arrayBuffer: async () =>
                new Uint8Array(object.value as Uint8Array).buffer,
            }
          : null;
      },
      put: async (
        key: string,
        value: unknown,
        options?: {
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
          customMetadata?: Record<string, string>;
        },
      ) => {
        const current = objects.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (
          options?.onlyIf?.etagMatches &&
          current?.etag !== options.onlyIf.etagMatches
        )
          return null;
        if (failPut?.(key, value)) throw new Error("R2 429: too many writes");
        version += 1;
        const etag = `etag${version}`;
        objects.set(key, {
          value,
          etag,
          customMetadata: options?.customMetadata,
        });
        return { key, etag };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort();
        const start = Number(cursor ?? 0);
        const page = keys.slice(start, start + listPageSize);
        const end = start + page.length;
        return {
          objects: page.map((key) => ({
            key,
            customMetadata: objects.get(key)?.customMetadata,
          })),
          delimitedPrefixes: [],
          ...(end < keys.length
            ? { truncated: true, cursor: String(end) }
            : { truncated: false }),
        };
      },
    } as unknown as R2Bucket,
  };
});

describe("Given a post queued by a service", () => {
  it("asks Buffer for the time and status of the post, keeps them and returns the time", async () => {
    const mediaId = await uploadImage();
    const requestId = crypto.randomUUID();
    const response = await call(
      "/api/buffer/posts",
      { requestId, mediaId, channelId: "li", text: "Post", mode: "addToQueue" },
      headersOf("application/json"),
    );
    expect(await response.json()).toEqual({
      postId: "post1",
      dueAt: nextDueAt,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).query).toContain("post { id dueAt status }");
    expect(
      JSON.parse(String(objects.get(`receipts/${requestId}`)?.value)),
    ).toMatchObject({ postId: "post1", dueAt: nextDueAt, status: "scheduled" });

    // A replay gives the same answer.
    const again = await call(
      "/api/buffer/posts",
      { requestId, mediaId, channelId: "li", text: "Post", mode: "addToQueue" },
      headersOf("application/json"),
    );
    expect(await again.json()).toEqual({ postId: "post1", dueAt: nextDueAt });
  });
  it("leaves the time out when Buffer names none", async () => {
    nextDueAt = null;
    const mediaId = await uploadImage();
    const response = await call(
      "/api/buffer/posts",
      {
        requestId: crypto.randomUUID(),
        mediaId,
        channelId: "li",
        text: "Post",
        mode: "addToQueue",
      },
      headersOf("application/json"),
    );
    expect(await response.json()).toEqual({ postId: "post1" });
  });
});

describe("Given an announcement to register", () => {
  it("stores it as pending for the posts of the service, with their Buffer IDs and time", async () => {
    const { body, response } = await announce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      announcementId: body.requestId,
      status: "pending",
      dueAt: nextDueAt,
    });
    expect(stored(body.requestId)).toMatchObject({
      id: body.requestId,
      service: "gieniek-bot",
      text: body.text,
      mediaIds: body.mediaIds,
      status: "pending",
      metadataStatus: "pending",
      attempts: 0,
      posts: [
        {
          requestId: body.postRequestIds[0],
          postId: "post1",
          dueAt: nextDueAt,
        },
        {
          requestId: body.postRequestIds[1],
          postId: "post2",
          dueAt: nextDueAt,
        },
      ],
    });
    expect(logged(infoLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-registered",
        announcementId: body.requestId,
        actor: "service",
        service: "gieniek-bot",
        postIds: ["post1", "post2"],
      }),
    );
    // Nothing goes to Discord when it is registered.
    expect(discordForms).toEqual([]);
  });
  it("refuses an operator, so Console cannot publish to Discord", async () => {
    as("user");
    const postRequestIds = await queuePosts(["li"]);
    const mediaIds = [await uploadImage()];
    const requestId = crypto.randomUUID();
    const response = await register({
      requestId,
      text: "From the browser",
      mediaIds,
      postRequestIds,
    });
    expect(response.status).toBe(403);
    expect(stored(requestId)).toBeUndefined();
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-denied",
        actor: "user",
        email: "operator@example.org",
      }),
    );
  });
  it("refuses a service token that is not allowlisted, and an unauthenticated call", async () => {
    const { body } = await announce();
    const again = { ...body, requestId: crypto.randomUUID() };
    authenticate.mockResolvedValue({
      kind: "service",
      clientId: otherClientId,
    });
    expect((await register(again)).status).toBe(403);
    authenticate.mockRejectedValue(new Error("no token"));
    expect((await register(again)).status).toBe(401);
    expect(stored(again.requestId)).toBeUndefined();
  });
  it("refuses a request that is not JSON", async () => {
    const response = await call(
      "/api/buffer/announcements",
      {},
      {
        "Content-Type": "text/plain",
      },
    );
    expect(response.status).toBe(415);
  });
  it.each([
    ["an empty text", { text: "   " }],
    ["a text over 1000 characters", { text: "x".repeat(1001) }],
    ["no images", { mediaIds: [] }],
    [
      "five images",
      { mediaIds: Array.from({ length: 5 }, () => crypto.randomUUID()) },
    ],
    ["no posts", { postRequestIds: [] }],
    ["an unknown key", { channel: "announcements" }],
  ])("refuses %s with 400", async (_name, changes) => {
    const { body, response } = await announce(changes);
    expect(response.status).toBe(400);
    expect(stored(body.requestId)).toBeUndefined();
  });
  it("refuses an image listed twice and a post listed twice", async () => {
    const postRequestIds = await queuePosts(["li"]);
    const mediaId = await uploadImage();
    const base = { text: "Short", mediaIds: [mediaId], postRequestIds };
    expect(
      (
        await register({
          ...base,
          requestId: crypto.randomUUID(),
          mediaIds: [mediaId, mediaId],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await register({
          ...base,
          requestId: crypto.randomUUID(),
          postRequestIds: [postRequestIds[0], postRequestIds[0]],
        })
      ).status,
    ).toBe(400);
  });
  it("takes up to four landscape or square images and refuses a portrait one", async () => {
    const squares = [];
    for (let index = 0; index < 4; index += 1)
      squares.push(await uploadImage(png(1080, 1080)));
    expect((await announce({ mediaIds: squares })).response.status).toBe(200);

    const portrait = await uploadImage(png(1080, 1350));
    const refused = await announce({ mediaIds: [portrait] });
    expect(refused.response.status).toBe(400);
    expect(await refused.response.json()).toEqual({
      message: "An announcement image has to be landscape or square.",
    });
  });
  it("refuses an image of someone else, a missing one, and one without a recorded size", async () => {
    as("user");
    const operatorImage = await uploadImage();
    as("service");
    expect(
      (await announce({ mediaIds: [operatorImage] })).response.status,
    ).toBe(403);
    expect(
      (await announce({ mediaIds: [crypto.randomUUID()] })).response.status,
    ).toBe(403);

    const old = crypto.randomUUID();
    objects.set(`images/${old}`, {
      value: png(),
      etag: "old",
      customMetadata: { owner: `service:${clientId}` },
    });
    expect((await announce({ mediaIds: [old] })).response.status).toBe(400);
  });
  it("names only posts the service created and Buffer confirmed", async () => {
    as("user");
    const operatorPosts = await queuePosts(["li"]);
    as("service");
    const unknown = await announce({ postRequestIds: [crypto.randomUUID()] });
    expect(unknown.response.status).toBe(403);
    const foreign = await announce({ postRequestIds: operatorPosts });
    expect(foreign.response.status).toBe(403);
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-denied",
        actor: "service",
      }),
    );

    // A post whose Buffer call never confirmed has a receipt without a post ID.
    const unconfirmed = crypto.randomUUID();
    objects.set(`receipts/${unconfirmed}`, {
      value: JSON.stringify({
        owner: `service:${clientId}`,
        fingerprint: "{}",
      }),
      etag: "receipt",
    });
    const response = await announce({ postRequestIds: [unconfirmed] });
    expect(response.response.status).toBe(409);
  });
  it("answers a retry with the same result and refuses changed content under the same ID", async () => {
    const { body, response } = await announce();
    const first = await response.json();
    const retry = await register(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(first);
    expect((await register({ ...body, text: "Changed" })).status).toBe(409);
    expect(stored(body.requestId).text).toBe(body.text);
  });
  it("refuses a second announcement for a post and keeps the other posts free", async () => {
    const { body } = await announce();
    const freshPost = (await queuePosts(["li"]))[0];
    const second = {
      ...body,
      requestId: crypto.randomUUID(),
      postRequestIds: [freshPost, body.postRequestIds[0]],
    };
    const response = await register(second);
    expect(response.status).toBe(409);
    expect(stored(second.requestId)).toBeUndefined();
    expect(objects.has(`announcement-posts/${freshPost}`)).toBe(false);

    // The free post can still get an announcement of its own.
    expect(
      (
        await register({
          ...body,
          requestId: crypto.randomUUID(),
          postRequestIds: [freshPost],
        })
      ).status,
    ).toBe(200);
  });
  it("lets go of its posts when a parallel request with the same ID and other posts wins", async () => {
    const first = await queuePosts(["li"]);
    const second = await queuePosts(["fb"]);
    const mediaIds = [await uploadImage()];
    const requestId = crypto.randomUUID();
    const results = await Promise.all([
      register({ requestId, text: "One", mediaIds, postRequestIds: first }),
      register({ requestId, text: "Two", mediaIds, postRequestIds: second }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const loser = stored(requestId).text === "One" ? second : first;
    expect(objects.has(`announcement-posts/${loser[0]}`)).toBe(false);
    expect(
      (
        await register({
          requestId: crypto.randomUUID(),
          text: "Again",
          mediaIds,
          postRequestIds: loser,
        })
      ).status,
    ).toBe(200);
  });
  it("lets go of a post an interrupted attempt took when a retry meets a taken post", async () => {
    const { body } = await announce();
    const fresh = (await queuePosts(["li"]))[0];
    const requestId = crypto.randomUUID();
    // An earlier attempt under this ID took the fresh post and stopped.
    objects.set(`announcement-posts/${fresh}`, {
      value: JSON.stringify({ announcementId: requestId }),
      etag: "claim",
    });
    const retry = await register({
      ...body,
      requestId,
      postRequestIds: [fresh, body.postRequestIds[0]],
    });
    expect(retry.status).toBe(409);
    expect(objects.has(`announcement-posts/${fresh}`)).toBe(false);
    // The post held by the first announcement keeps its claim.
    expect(objects.has(`announcement-posts/${body.postRequestIds[0]}`)).toBe(
      true,
    );
  });
  it("finishes a registration that stopped after taking its posts", async () => {
    const postRequestIds = await queuePosts();
    const requestId = crypto.randomUUID();
    objects.set(`announcement-posts/${postRequestIds[0]}`, {
      value: JSON.stringify({ announcementId: requestId }),
      etag: "claim",
    });
    const response = await register({
      requestId,
      text: "Short",
      mediaIds: [await uploadImage()],
      postRequestIds,
    });
    expect(response.status).toBe(200);
  });
  it("answers from the stored announcement when a parallel request wrote it first", async () => {
    const postRequestIds = await queuePosts();
    const body = {
      requestId: crypto.randomUUID(),
      text: "Short",
      mediaIds: [await uploadImage()],
      postRequestIds,
    };
    const results = await Promise.all([register(body), register(body)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
  });
});

describe("Given the scheduled run", () => {
  async function registered(changes: Record<string, unknown> = {}) {
    const { body, response } = await announce(changes);
    expect(response.status).toBe(200);
    return body;
  }
  function discordPayload(index = 0) {
    return JSON.parse(String(discordForms[index].get("payload_json")));
  }

  it("posts exactly one Discord message once the first post was sent, with its images", async () => {
    const body = await registered();
    bufferPosts.set("post2", postStatus("sent", nextDueAt));
    await runCron(at(2 * HOUR));

    expect(discordForms).toHaveLength(1);
    expect(discordUrls[0]).toBe(`${webhook}?wait=true`);
    expect(discordPayload()).toEqual({
      content: body.text,
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: "announcement-1.png" }],
    });
    const file = discordForms[0].get("files[0]") as File;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png());

    expect(stored(body.requestId)).toMatchObject({
      status: "posted",
      metadataStatus: "posted",
      attempts: 1,
      posted: { messageId: "message1", afterPostId: "post2" },
    });
    expect(logged(infoLog)).toContainEqual(
      expect.objectContaining({
        action: "discord-announcement-posted",
        announcementId: body.requestId,
        messageId: "message1",
        afterPostId: "post2",
      }),
    );

    // Later runs leave it alone.
    await runCron(at(3 * HOUR));
    await runCron(at(4 * HOUR));
    expect(discordForms).toHaveLength(1);
  });
  it("keeps a second between the lock and the write after Discord, as R2 needs", async () => {
    await registered();
    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(2 * HOUR));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1000);
    expect(waits[0]).toBeLessThanOrEqual(1100);
  });
  it("tries the write after Discord once more when R2 refuses it", async () => {
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    let refused = 0;
    failPut = (key, value) =>
      key.startsWith("announcements/") &&
      String(value).includes('"status":"posted"') &&
      ++refused === 1;
    await runCron(at(2 * HOUR));
    expect(stored(body.requestId).status).toBe("posted");
    expect(waits).toEqual([expect.any(Number), 1100]);
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-write-retried",
        status: "posted",
      }),
    );
    expect(discordForms).toHaveLength(1);
  });
  it("leaves it sending, and never sends again, when R2 refuses that write twice", async () => {
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    failPut = (key, value) =>
      key.startsWith("announcements/") &&
      String(value).includes('"status":"posted"');
    await runCron(at(2 * HOUR));
    await runCron(at(3 * HOUR));
    expect(stored(body.requestId).status).toBe("sending");
    expect(discordForms).toHaveLength(1);
  });
  it("is what the Cron Trigger of the Worker runs", async () => {
    nextDueAt = null;
    await registered();
    bufferPosts.set("post1", postStatus("sent"));
    await worker.scheduled({} as ScheduledController, env);
    expect(discordForms).toHaveLength(1);
  });
  it("sends several images as attachments in their order and pings nobody", async () => {
    const images = [
      await uploadImage(png(1080, 1080)),
      await uploadImage(png(1000, 1000)),
    ];
    const body = await registered({
      mediaIds: images,
      text: "Hello @everyone and <@&123>",
    });
    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(2 * HOUR));
    expect(discordPayload()).toMatchObject({
      content: body.text,
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: "announcement-1.png" },
        { id: 1, filename: "announcement-2.png" },
      ],
    });
    const second = discordForms[0].get("files[1]") as File;
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png(1000, 1000));
  });
  it("posts the text when an image has expired from R2, and says so in the log", async () => {
    const body = await registered();
    objects.delete(`images/${body.mediaIds[0]}`);
    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(2 * HOUR));
    expect(discordPayload()).toMatchObject({ attachments: [] });
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({ action: "announcement-image-missing" }),
    );
  });
  it("waits while the posts are scheduled, keeping the time Buffer gives", async () => {
    const body = await registered();
    const moved = new Date(at(5 * HOUR)).toISOString();
    bufferPosts.set("post1", postStatus("scheduled", moved));
    bufferPosts.set("post2", postStatus("sending", moved));
    await runCron(at(2 * HOUR));

    expect(discordForms).toEqual([]);
    expect(stored(body.requestId)).toMatchObject({
      status: "pending",
      posts: [
        { dueAt: moved, status: "scheduled" },
        { dueAt: moved, status: "sending" },
      ],
    });

    // Rescheduled to later: the next runs do not ask Buffer before that time.
    const asked = bufferQueries().length;
    await runCron(at(3 * HOUR));
    expect(bufferQueries()).toHaveLength(asked);
  });
  it("does not ask Buffer before a post is due, except every six hours", async () => {
    nextDueAt = new Date(at(2 * DAY)).toISOString();
    await registered();
    await runCron(at(HOUR));
    expect(bufferQueries()).toHaveLength(0);

    await runCron(at(7 * HOUR));
    expect(bufferQueries()).toHaveLength(2);
    await runCron(at(8 * HOUR));
    expect(bufferQueries()).toHaveLength(2);
  });
  it("asks Buffer every run when it named no time for the posts", async () => {
    nextDueAt = null;
    await registered();
    await runCron();
    await runCron();
    expect(bufferQueries()).toHaveLength(4);
  });
  it("cancels the announcement when the posts were deleted in Buffer before they went out", async () => {
    const body = await registered();
    bufferPosts.set("post1", notFound);
    bufferPosts.set("post2", notFound);
    await runCron(at(2 * HOUR));

    expect(discordForms).toEqual([]);
    expect(stored(body.requestId)).toMatchObject({
      status: "cancelled",
      metadataStatus: "cancelled",
      posts: [{ status: "deleted" }, { status: "deleted" }],
    });
    expect(logged(infoLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-cancelled",
        statuses: ["deleted", "deleted"],
      }),
    );
    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(3 * HOUR));
    expect(discordForms).toEqual([]);
  });
  it("cancels it when every post failed or was deleted, and waits while one is left", async () => {
    const failed = await registered();
    bufferPosts.set("post1", postStatus("error"));
    bufferPosts.set("post2", notFound);
    await runCron(at(2 * HOUR));
    expect(stored(failed.requestId).status).toBe("cancelled");

    const waiting = await registered();
    bufferPosts.set("post3", notFound);
    bufferPosts.set("post4", postStatus("scheduled"));
    await runCron(at(2 * HOUR));
    expect(stored(waiting.requestId).status).toBe("pending");

    // The post that is left goes out: the announcement follows it.
    bufferPosts.set("post4", postStatus("sent"));
    await runCron(at(3 * HOUR));
    expect(stored(waiting.requestId).status).toBe("posted");
    expect(discordForms).toHaveLength(1);
  });
  it("posts nothing for a post created without an announcement", async () => {
    as("user");
    await queuePosts(["li"]);
    as("service");
    await queuePosts(["fb"]);
    bufferPosts.set("post1", postStatus("sent"));
    bufferPosts.set("post2", postStatus("sent"));
    await runCron(at(2 * HOUR));
    expect(discordForms).toEqual([]);
    expect(bufferQueries()).toEqual([]);
  });
  it("keeps it pending when Buffer cannot be asked, and posts on a later run", async () => {
    const body = await registered();
    bufferPosts.set("post1", () => new Response("down", { status: 502 }));
    await runCron(at(2 * HOUR));
    bufferPosts.set("post1", () =>
      Response.json({ data: null, errors: [{ message: "Unexpected" }] }),
    );
    await runCron(at(2 * HOUR));
    expect(stored(body.requestId).status).toBe("pending");
    expect(
      logged(errorLog).filter(
        (line) => line.action === "announcement-check-failed",
      ),
    ).toHaveLength(2);

    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(3 * HOUR));
    expect(stored(body.requestId).status).toBe("posted");
    expect(discordForms).toHaveLength(1);
  });
  it("retries on the next run when Discord refuses, and posts once", async () => {
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    discordAnswer = () =>
      Response.json({ message: "rate limited" }, { status: 429 });
    await runCron(at(2 * HOUR));
    expect(stored(body.requestId)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Discord HTTP 429",
    });
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({
        action: "discord-announcement-failed",
        willRetry: true,
      }),
    );

    discordAnswer = () => new Response(null, { status: 204 });
    await runCron(at(3 * HOUR));
    await runCron(at(4 * HOUR));
    expect(discordForms).toHaveLength(2);
    expect(stored(body.requestId)).toMatchObject({
      status: "posted",
      attempts: 2,
      posted: { afterPostId: "post1" },
    });
    expect(stored(body.requestId)).not.toHaveProperty("lastError");
    expect(stored(body.requestId).posted).not.toHaveProperty("messageId");
  });
  it("gives up after a day of refusals", async () => {
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    discordAnswer = () => Response.json({}, { status: 404 });
    for (let run = 0; run < 25; run += 1) {
      await runCron(at(2 * HOUR + run * HOUR));
    }
    expect(discordForms).toHaveLength(24);
    expect(stored(body.requestId)).toMatchObject({
      status: "failed",
      attempts: 24,
    });
  });
  it.each([
    ["a server error", () => Response.json({}, { status: 502 })],
    [
      "no answer",
      () => {
        throw new Error("timed out");
      },
    ],
  ])("never sends again after %s, when the message may exist", async (_name, answer) => {
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    discordAnswer = answer;
    await runCron(at(2 * HOUR));
    await runCron(at(3 * HOUR));
    expect(discordForms).toHaveLength(1);
    expect(stored(body.requestId).status).toBe("unconfirmed");
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({ action: "discord-announcement-unconfirmed" }),
    );
  });
  it("posts once when two runs overlap", async () => {
    await registered();
    bufferPosts.set("post1", postStatus("sent"));
    await Promise.all([runCron(at(2 * HOUR)), runCron(at(2 * HOUR))]);
    expect(discordForms).toHaveLength(1);
    expect(logged(infoLog)).toContainEqual(
      expect.objectContaining({ action: "announcement-changed-meanwhile" }),
    );
  });
  it("gives up an announcement still waiting after 45 days", async () => {
    nextDueAt = null;
    const body = await registered();
    await runCron(at(46 * DAY));
    expect(stored(body.requestId).status).toBe("expired");
    expect(bufferQueries()).toEqual([]);
  });
  it("leaves the rest for the next run when its requests run out", async () => {
    nextDueAt = null;
    listPageSize = 5;
    for (let index = 0; index < 22; index += 1) await registered();
    await runCron();
    // Two posts each, and one request kept for Discord: 19 fit in 40 requests.
    expect(bufferQueries()).toHaveLength(38);
    expect(logged(infoLog)).toContainEqual(
      expect.objectContaining({ action: "announcements-deferred", left: 3 }),
    );
  });
  it("goes on with the others when one announcement is unreadable", async () => {
    objects.set("announcements/broken.json", {
      value: "not JSON",
      etag: "broken",
      customMetadata: { status: "pending" },
    });
    const body = await registered();
    bufferPosts.set("post1", postStatus("sent"));
    await runCron(at(2 * HOUR));
    expect(stored(body.requestId).status).toBe("posted");
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({
        action: "announcement-check-failed",
        key: "announcements/broken.json",
      }),
    );
  });
  it.each([
    [
      "the webhook is not set",
      { DISCORD_ANNOUNCE_WEBHOOK_URL: undefined },
      "missing",
    ],
    [
      "the webhook is not Discord's",
      { DISCORD_ANNOUNCE_WEBHOOK_URL: "https://example.org/api/webhooks/1/x" },
      "invalid",
    ],
    [
      "the webhook is plain HTTP",
      { DISCORD_ANNOUNCE_WEBHOOK_URL: "http://discord.com/api/webhooks/1/x" },
      "invalid",
    ],
    [
      "the webhook carries a query",
      { DISCORD_ANNOUNCE_WEBHOOK_URL: `${webhook}?thread_id=1` },
      "invalid",
    ],
    [
      "the webhook is not a URL",
      { DISCORD_ANNOUNCE_WEBHOOK_URL: "not a url" },
      "invalid",
    ],
  ])("does nothing but log when %s", async (_name, changes, state) => {
    await registered();
    bufferPosts.set("post1", postStatus("sent"));
    Object.assign(env, changes);
    await runCron(at(2 * HOUR));
    expect(bufferQueries()).toEqual([]);
    expect(discordForms).toEqual([]);
    const line = logged(infoLog).find(
      (entry) => entry.action === "announcements-not-configured",
    );
    expect(line).toEqual({
      action: "announcements-not-configured",
      webhook: state,
      buffer: "set",
    });
  });
  it("does nothing without the Buffer key", async () => {
    env.BUFFER_API_KEY = "";
    await runCron();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged(infoLog)).toContainEqual({
      action: "announcements-not-configured",
      webhook: "set",
      buffer: "missing",
    });
  });
  it("logs and stops when the announcements cannot be listed", async () => {
    (env.MEDIA as unknown as { list: () => never }).list = () => {
      throw new Error("R2 unavailable");
    };
    await runCron();
    expect(logged(errorLog)).toContainEqual(
      expect.objectContaining({ action: "announcements-list-failed" }),
    );
  });
  it("never writes the webhook into a log line", async () => {
    await registered();
    bufferPosts.set("post1", postStatus("sent"));
    discordAnswer = () => Response.json({}, { status: 500 });
    await runCron(at(2 * HOUR));
    const lines = [...infoLog.mock.calls, ...errorLog.mock.calls].map(
      ([line]) => String(line),
    );
    expect(lines.join("\n")).not.toContain("Secret-Webhook_Token");
  });
});
