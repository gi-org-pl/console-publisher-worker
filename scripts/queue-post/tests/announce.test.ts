// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientSecret,
  count,
  dir,
  env,
  png,
  script,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

const both = ["li1", "ig1"];
const announce = {
  text: "Short version. https://gi.org.pl",
  images: ["a.png"],
};

function landscape(width = 1200, height = 630) {
  const bytes = png();
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

async function writeAnnounceJob(changes: Record<string, unknown> = {}) {
  await writeFile(path.join(dir, "a.png"), landscape());
  return writeJob({ channels: both, announce, ...changes });
}

async function storedAnnouncement(id: string) {
  const object = await env.MEDIA.get(`announcements/${id}.json`);
  return object && (await object.json<Record<string, unknown>>());
}

describe("an announcement in a job", () => {
  it("is shown on preview with its request ID, and nothing is sent", async () => {
    const job = await writeAnnounceJob();
    const { exitCode, document } = await script(["preview", job]);
    expect(exitCode).toBe(0);
    expect(document.announce).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8/),
      text: announce.text,
      images: ["a.png"],
    });
    expect(
      document.channels.map((c: { requestId: string }) => c.requestId),
    ).not.toContain(document.announce.requestId);
    expect(seen).toHaveLength(0);

    // The same post name gives the same announcement ID on every run.
    const again = await script(["preview", job]);
    expect(again.document.announce.requestId).toBe(document.announce.requestId);
  });
  it("leaves a job without one as it was", async () => {
    const job = await writeJob({ channels: both });
    const preview = await script(["preview", job]);
    expect(preview.document).not.toHaveProperty("announce");
    const queued = await script(["queue", job]);
    expect(queued.exitCode).toBe(0);
    expect(queued.document).not.toHaveProperty("announcement");
    expect(count("announcements")).toBe(0);
  });
  it.each([
    [
      "an empty text",
      { announce: { ...announce, text: "  " } },
      "announce.text",
    ],
    [
      "a text over 1000 characters",
      { announce: { ...announce, text: "x".repeat(1001) } },
      "announce.text",
    ],
    ["no images", { announce: { ...announce, images: [] } }, "announce.images"],
    [
      "five images",
      { announce: { ...announce, images: Array(5).fill("a.png") } },
      "announce.images",
    ],
    ["an unknown key", { announce: { ...announce, link: "x" } }, "announce"],
  ])("is refused with %s before any request", async (_name, changes, where) => {
    const job = await writeAnnounceJob(changes);
    for (const command of ["preview", "queue"]) {
      const { exitCode, document } = await script([command, job]);
      expect(exitCode).toBe(1);
      expect(document.error).toContain(`(see: ${where})`);
    }
    expect(seen).toHaveLength(0);
  });
  it.each([
    ["a portrait image", landscape(1080, 1350)],
    [
      "a file that is not a PNG",
      new TextEncoder().encode("not a png at all, no"),
    ],
  ])("is refused with %s before any request", async (_name, bytes) => {
    const job = await writeAnnounceJob();
    await writeFile(path.join(dir, "a.png"), bytes);
    const { exitCode, document } = await script(["preview", job]);
    expect(exitCode).toBe(1);
    expect(document.error).toBe(
      'The announcement image "a.png" has to be a PNG, landscape or square.',
    );
    expect(seen).toHaveLength(0);
  });
  it("keeps its images inside the folder of the job and its text free of the token", async () => {
    // The image exists, one folder above the job.
    await writeFile(path.join(dir, "a.png"), landscape());
    await mkdir(path.join(dir, "job"));
    await writeFile(path.join(dir, "job", "post.png"), png());
    await writeFile(
      path.join(dir, "job", "post.json"),
      JSON.stringify({
        name: "autumn-news",
        text: "Hi",
        image: "post.png",
        channels: both,
        announce: { ...announce, images: ["../a.png"] },
      }),
    );
    expect((await script(["preview", "job/post.json"])).document.error).toBe(
      'The image "../a.png" is not inside the folder of the job.',
    );
    const leaking = await writeAnnounceJob({
      announce: { ...announce, text: `token ${clientSecret}` },
    });
    expect((await script(["queue", leaking])).document.error).toContain(
      "contains the service token",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("queue with an announcement", () => {
  it("uploads its images, queues the posts, then registers it for all of them", async () => {
    const job = await writeAnnounceJob({
      announce: { ...announce, images: ["a.png", "b.png"] },
    });
    await writeFile(path.join(dir, "b.png"), landscape(1080, 1080));
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(0);
    expect(count("media")).toBe(3);
    expect(count("posts")).toBe(2);
    expect(seen.at(-1)?.path).toBe("/api/buffer/announcements");
    expect(document.announcement).toEqual({
      requestId: expect.any(String),
      step: "announce",
      status: 200,
      response: { announcementId: expect.any(String), status: "pending" },
    });

    const stored = await storedAnnouncement(document.announcement.requestId);
    expect(stored).toMatchObject({
      text: announce.text,
      status: "pending",
      service: "gieniek-bot",
      posts: [
        { requestId: document.results[0].requestId, postId: "post1" },
        { requestId: document.results[1].requestId, postId: "post2" },
      ],
    });
    // The images of the announcement are its own, not those of the post.
    expect(stored?.mediaIds).toHaveLength(2);
  });
  it("names only the posts that exist when the Worker refuses a channel", async () => {
    const job = await writeAnnounceJob();
    standIn.answer = (request) =>
      request.path === "/api/buffer/posts" && count("posts") === 2
        ? Response.json(
            { message: "This channel is not allowed." },
            { status: 403 },
          )
        : undefined;
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.announcement.status).toBe(200);
    const stored = await storedAnnouncement(document.announcement.requestId);
    expect(stored?.posts).toEqual([
      expect.objectContaining({ requestId: document.results[0].requestId }),
    ]);
  });
  it("is answered 409 on a second run, like the posts, and nothing is announced twice", async () => {
    const job = await writeAnnounceJob();
    expect((await script(["queue", job])).exitCode).toBe(0);
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.results.map((r: { status: number }) => r.status)).toEqual([
      409, 409,
    ]);
    expect(document.announcement).toMatchObject({
      step: "announce",
      status: 409,
      response: { message: "This announcement was already registered." },
    });
  });
  it("is registered on a second run when the first one stopped before it", async () => {
    const job = await writeAnnounceJob();
    standIn.answer = (request) =>
      request.path === "/api/buffer/announcements"
        ? new Response("unavailable", { status: 503 })
        : undefined;
    const first = await script(["queue", job]);
    expect(first.exitCode).toBe(1);
    expect(first.document.announcement).toMatchObject({
      status: 503,
      response: "unavailable",
    });

    standIn.answer = () => undefined;
    const second = await script(["queue", job]);
    // The posts exist from the first run (409); the announcement names them.
    expect(second.document.announcement.status).toBe(200);
    const stored = await storedAnnouncement(
      second.document.announcement.requestId,
    );
    expect(stored?.posts).toHaveLength(2);
  });
  it("is not registered for the old posts when the job was edited under the same name", async () => {
    const job = await writeAnnounceJob();
    standIn.answer = (request) =>
      request.path === "/api/buffer/announcements"
        ? new Response("unavailable", { status: 503 })
        : undefined;
    expect((await script(["queue", job])).exitCode).toBe(1);

    standIn.answer = () => undefined;
    await writeAnnounceJob({
      text: "An edited post",
      announce: { ...announce, text: "An edited announcement" },
    });
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.announcement).toMatchObject({
      status: 409,
      response: {
        message:
          "One of the posts was queued with another text. A changed post needs a new name.",
      },
    });
    expect(
      await storedAnnouncement(document.announcement.requestId),
    ).toBeNull();
  });
  it("posts nothing when an image of the announcement fails to upload", async () => {
    const job = await writeAnnounceJob();
    standIn.answer = (request) =>
      request.path === "/api/buffer/media" && count("media") === 2
        ? Response.json({ message: "Choose a PNG image." }, { status: 415 })
        : undefined;
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(count("posts")).toBe(0);
    expect(document.results.map((r: { step: string }) => r.step)).toEqual([
      "upload",
      "upload",
    ]);
    expect(document.announcement).toEqual({
      requestId: expect.any(String),
      step: "skipped",
      response: "No post exists, so nothing was announced.",
    });
    expect(count("announcements")).toBe(0);
  });
});
