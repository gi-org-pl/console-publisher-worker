// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferPosts,
  type Channel,
  clientId,
  clientSecret,
  count,
  dir,
  env,
  instagram,
  linkedin,
  mp4,
  png,
  type Seen,
  script,
  seen,
  standIn,
  useWorkerStandIn,
  viaWorker,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

const facebook = {
  id: "fb1",
  name: "Foundation Facebook",
  service: "facebook",
};
const videoUrl = expect.stringMatching(
  /^https:\/\/console\.gi\.org\.pl\/buffer-media\/[0-9a-f-]{36}\.mp4$/,
);

/** A reel job on Instagram and Facebook, with the video next to it. */
async function writeReelJob(changes: Record<string, unknown> = {}) {
  env.CHANNELS_JSON = JSON.stringify([linkedin, instagram, facebook]);
  await writeFile(path.join(dir, "reel.mp4"), mp4());
  return writeJob({
    name: "autumn-reel",
    type: "reel",
    image: undefined,
    video: "reel.mp4",
    channels: ["ig1", "fb1"],
    ...changes,
  });
}

const statuses = (results: Channel[]) => results.map((r) => r.status);

describe("a video in a job", () => {
  it("is shown on preview with its options, and nothing is sent", async () => {
    const job = await writeReelJob({ shareToFeed: false, thumbnailOffset: 0 });
    const { exitCode, document } = await script(["preview", job]);
    expect(exitCode).toBe(0);
    expect(document).toEqual({
      ok: true,
      command: "preview",
      name: "autumn-reel",
      type: "reel",
      text: "Hello from the job",
      video: "reel.mp4",
      shareToFeed: false,
      thumbnailOffset: 0,
      channels: [
        { channelId: "ig1", requestId: expect.any(String) },
        { channelId: "fb1", requestId: expect.any(String) },
      ],
    });
    expect(seen).toHaveLength(0);
  });

  it("gives a reel request IDs of its own, apart from a post of the same name", async () => {
    const reel = await script(["preview", await writeReelJob()]);
    const asPost = await script([
      "preview",
      await writeReelJob({ type: "post", channels: ["ig1"] }),
    ]);
    expect(reel.document.channels[0].requestId).not.toBe(
      asPost.document.channels[0].requestId,
    );
  });

  it.each([
    ["a video and an image", { image: "post.png" }],
    ["a video and images", { images: ["post.png"] }],
    ["two videos", { video: ["reel.mp4", "reel.mp4"] }],
    ["a reel without a text", { text: undefined }],
    ["shareToFeed without a video", { video: undefined, image: "post.png" }],
    [
      "a thumbnail offset without a video",
      {
        type: "post",
        video: undefined,
        image: "post.png",
        shareToFeed: undefined,
        thumbnailOffset: 100,
      },
    ],
    ["a thumbnail offset that is no whole number", { thumbnailOffset: 1.5 }],
  ])("refuses %s as a malformed job, before any request", async (_name, change) => {
    const job = await writeReelJob({ shareToFeed: true, ...change });
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.error).toMatch(/^The job is not valid/);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [
      "outside the folder",
      "../reel.mp4",
      "is not inside the folder of the job",
    ],
    ["that does not exist", "missing.mp4", "cannot be read"],
  ])("refuses a video %s before any request", async (_name, video, message) => {
    await mkdir(path.join(dir, "job"));
    await writeFile(path.join(dir, "reel.mp4"), mp4());
    await writeFile(
      path.join(dir, "job", "post.json"),
      JSON.stringify({
        name: "autumn-reel",
        type: "reel",
        text: "Hi",
        video,
        channels: ["ig1"],
      }),
    );
    const { exitCode, document } = await script([
      "queue",
      path.join("job", "post.json"),
    ]);
    expect(exitCode).toBe(1);
    expect(document.error).toBe(`The video "${video}" ${message}.`);
    expect(seen).toHaveLength(0);
  });

  it("is never sent with the token in its path", async () => {
    const job = await writeReelJob({ video: `${clientSecret}.mp4` });
    await writeFile(path.join(dir, `${clientSecret}.mp4`), mp4());
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.error).toBe(
      "The text, a channel or a file path of the job contains the service token. Nothing was sent.",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("queue with a video", () => {
  it("uploads the MP4 once with its length and creates a reel per channel", async () => {
    const job = await writeReelJob({
      shareToFeed: false,
      thumbnailOffset: 1500,
    });
    const uploads: Seen[] = [];
    const { exitCode, document } = await script(["queue", job], {
      fetch: (input: string, init: RequestInit) => {
        const sent = viaWorker(input, init);
        if (String(input).endsWith("/api/buffer/media"))
          uploads.push(seen.at(-1) as Seen);
        return sent;
      },
    });
    expect(exitCode).toBe(0);
    expect(statuses(document.results)).toEqual([200, 200]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].headers.get("Content-Type")).toBe("video/mp4");
    expect(uploads[0].headers.get("Content-Length")).toBe("64");

    const [onInstagram, onFacebook] = bufferPosts();
    expect(onInstagram).toMatchObject({
      channelId: "ig1",
      text: "Hello from the job",
      mode: "addToQueue",
      assets: [
        { video: { url: videoUrl, metadata: { thumbnailOffset: 1500 } } },
      ],
      metadata: { instagram: { type: "reel", shouldShareToFeed: false } },
    });
    expect(onFacebook).toMatchObject({
      channelId: "fb1",
      assets: [{ video: { url: videoUrl } }],
      metadata: { facebook: { type: "reel" } },
    });
    expect(onFacebook.assets[0].video).not.toHaveProperty("metadata");
    // The video Buffer is sent is the one uploaded, at its public address.
    const stored = await env.MEDIA.get(
      `images/${onInstagram.assets[0].video.url.split("/").at(-1)}`,
    );
    expect(
      new Uint8Array(await (stored as unknown as Response).arrayBuffer()),
    ).toEqual(mp4());
  });

  it("queues a LinkedIn video as a plain post", async () => {
    const job = await writeReelJob({ type: "post", channels: ["li1"] });
    const { exitCode } = await script(["queue", job]);
    expect(exitCode).toBe(0);
    const [onLinkedIn] = bufferPosts();
    expect(onLinkedIn.assets).toEqual([{ video: { url: videoUrl } }]);
    expect(onLinkedIn).not.toHaveProperty("metadata");
  });

  it("prints the Worker's 400 for a reel on LinkedIn, and the other channels still get theirs", async () => {
    const job = await writeReelJob({ channels: ["li1", "ig1"] });
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.results).toMatchObject([
      {
        channelId: "li1",
        step: "post",
        status: 400,
        response: { message: "This channel has no reels." },
      },
      { channelId: "ig1", step: "post", status: 200 },
    ]);
  });

  it("posts nothing when the Worker refuses the video, and says so per channel", async () => {
    const job = await writeReelJob();
    await writeFile(path.join(dir, "reel.mp4"), png());
    const { exitCode, document } = await script(["queue", job]);
    expect(exitCode).toBe(1);
    expect(document.results).toMatchObject([
      { channelId: "ig1", step: "upload", status: 400 },
      { channelId: "fb1", step: "upload", status: 400 },
    ]);
    expect(count("posts")).toBe(0);
  });

  it("gives a video upload more time than the other requests", async () => {
    const job = await writeReelJob({ channels: ["ig1"] });
    const { exitCode } = await script(["queue", job], {
      timeoutMs: 20,
      fetch: async (input: string, init: RequestInit) => {
        if (String(input).endsWith("/api/buffer/media"))
          await new Promise((resolve) => setTimeout(resolve, 60));
        if (init.signal?.aborted) throw new Error("timed out");
        return viaWorker(input, init);
      },
    });
    expect(exitCode).toBe(0);
  });

  it("answers a second run with 409 for every channel, as for images", async () => {
    const job = await writeReelJob();
    expect((await script(["queue", job])).exitCode).toBe(0);
    const { document } = await script(["queue", job]);
    expect(statuses(document.results)).toEqual([409, 409]);
    expect(bufferPosts()).toHaveLength(2);
  });
});

describe("a reel with an announcement", () => {
  const announce = { text: "A new reel. https://gi.org.pl", images: ["a.png"] };

  it("registers the announcement for the reels, with a PNG of its own", async () => {
    await writeFile(path.join(dir, "a.png"), png());
    const job = await writeReelJob({ announce });
    const bodies: Record<string, unknown>[] = [];
    const { exitCode, document } = await script(["queue", job], {
      fetch: (input: string, init: RequestInit) => {
        if (String(input).endsWith("/api/buffer/announcements"))
          bodies.push(JSON.parse(String(init.body)));
        return viaWorker(input, init);
      },
    });
    expect(exitCode).toBe(0);
    expect(document.announcement).toMatchObject({
      step: "announce",
      status: 200,
    });
    expect(bodies).toEqual([
      expect.objectContaining({
        postText: "Hello from the job",
        postVideoId: expect.any(String),
        postRequestIds: document.results.map((r: Channel) => r.requestId),
      }),
    ]);
    expect(bodies[0]).not.toHaveProperty("postMediaIds");
  });

  it("refuses the announcement of a reel whose video changed under the same name", async () => {
    await writeFile(path.join(dir, "a.png"), png());
    const job = await writeReelJob({ announce, channels: ["ig1"] });
    // The first run queues the reel and stops before the announcement.
    standIn.answer = (request) =>
      request.path === "/api/buffer/announcements"
        ? Response.json({ message: "Try again." }, { status: 503 })
        : undefined;
    expect((await script(["queue", job])).exitCode).toBe(1);

    standIn.answer = () => undefined;
    const changed = mp4();
    changed[40] = 0;
    await writeFile(path.join(dir, "reel.mp4"), changed);
    const { document } = await script(["queue", job]);
    expect(document.announcement).toMatchObject({
      status: 409,
      response: {
        message:
          "One of the posts was queued with another video. A changed post needs a new name.",
      },
    });
  });

  it("registers the announcement on a second run when the video is the same", async () => {
    await writeFile(path.join(dir, "a.png"), png());
    const job = await writeReelJob({ announce, channels: ["ig1"] });
    standIn.answer = (request) =>
      request.path === "/api/buffer/announcements"
        ? Response.json({ message: "Try again." }, { status: 503 })
        : undefined;
    expect((await script(["queue", job])).exitCode).toBe(1);

    standIn.answer = () => undefined;
    const { document } = await script(["queue", job]);
    expect(document.results[0].status).toBe(409);
    expect(document.announcement).toMatchObject({ status: 200 });
  });

  it("is refused by the Worker when the video it names is not there", async () => {
    await writeFile(path.join(dir, "a.png"), png());
    const job = await writeReelJob({ announce, channels: ["ig1"] });
    standIn.answer = (request) =>
      request.path === "/api/buffer/announcements"
        ? Response.json({ message: "Try again." }, { status: 503 })
        : undefined;
    const { document } = await script(["queue", job]);
    standIn.answer = () => undefined;
    const upload = await viaWorker(
      "https://console.gi.org.pl/api/buffer/media",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "Content-Type": "image/png",
        },
        body: png(),
        redirect: "manual",
      },
    );
    const { mediaId } = (await upload.json()) as { mediaId: string };
    const answer = await viaWorker(
      "https://console.gi.org.pl/api/buffer/announcements",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          text: "Gone",
          mediaIds: [mediaId],
          postRequestIds: [document.results[0].requestId],
          postVideoId: crypto.randomUUID(),
        }),
        redirect: "manual",
      },
    );
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({
      message: "The video expired or belongs to another operator.",
    });
  });

  it("is refused by the Worker when its post content names images and a video", async () => {
    const answer = await viaWorker(
      "https://console.gi.org.pl/api/buffer/announcements",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          text: "Both",
          mediaIds: [crypto.randomUUID()],
          postRequestIds: [crypto.randomUUID()],
          postMediaIds: [crypto.randomUUID()],
          postVideoId: crypto.randomUUID(),
        }),
        redirect: "manual",
      },
    );
    expect(answer.status).toBe(400);
  });
});
