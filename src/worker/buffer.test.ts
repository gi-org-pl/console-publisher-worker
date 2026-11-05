import { describe, expect, it } from "vitest";
import type { PostType, PublishInput } from "../schemas/publishing";
import { channelMetadata, firstCommentError } from "./buffer";
import type { Channel } from "./types";

/** The metadata of a post of this type, with this first comment, if any. */
const metadataOf = (
  channel: Channel,
  type: PostType,
  firstComment?: string,
  more: Partial<PublishInput> = {},
) =>
  channelMetadata(channel, {
    requestId: "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df",
    channelId: channel.id,
    text: "Hello",
    mode: "addToQueue",
    type,
    ...(firstComment === undefined ? {} : { firstComment }),
    ...more,
  });

const on = (service: Channel["service"]): Channel => ({
  id: "c1",
  name: "Channel",
  service,
});

describe("the metadata Buffer gets for a channel", () => {
  it("carries the first comment for Instagram, next to the post type", () => {
    expect(metadataOf(on("instagram"), "post", "Link: x.org")).toEqual({
      instagram: {
        type: "post",
        shouldShareToFeed: true,
        firstComment: "Link: x.org",
      },
    });
  });

  it("carries the first comment for Facebook, next to the post type", () => {
    expect(metadataOf(on("facebook"), "post", "Link: x.org")).toEqual({
      facebook: { type: "post", firstComment: "Link: x.org" },
    });
  });

  it("carries the first comment for LinkedIn, which needs no type", () => {
    expect(metadataOf(on("linkedin"), "post", "Link: x.org")).toEqual({
      linkedin: { firstComment: "Link: x.org" },
    });
  });

  it("stays what it was without a first comment", () => {
    expect(metadataOf(on("instagram"), "post")).toEqual({
      instagram: { type: "post", shouldShareToFeed: true },
    });
    expect(metadataOf(on("instagram"), "story")).toEqual({
      instagram: { type: "story", shouldShareToFeed: false },
    });
    expect(metadataOf(on("facebook"), "post")).toEqual({
      facebook: { type: "post" },
    });
    for (const service of [
      "linkedin",
      "threads",
      "bluesky",
      "mastodon",
      "twitter",
    ] as const) {
      expect(metadataOf(on(service), "post")).toBeUndefined();
    }
  });

  it("carries the first comment for an Instagram reel, next to its feed setting", () => {
    expect(
      metadataOf(on("instagram"), "reel", "Link: x.org", {
        shareToFeed: false,
      }),
    ).toEqual({
      instagram: {
        type: "reel",
        shouldShareToFeed: false,
        firstComment: "Link: x.org",
      },
    });
  });

  it("carries the first comment for a LinkedIn video, which is a post", () => {
    expect(
      metadataOf(on("linkedin"), "post", "Link: x.org", {
        videoId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toEqual({ linkedin: { firstComment: "Link: x.org" } });
  });

  it("keeps the metadata of a reel as it was without a first comment", () => {
    expect(metadataOf(on("instagram"), "reel")).toEqual({
      instagram: { type: "reel", shouldShareToFeed: true },
    });
    expect(metadataOf(on("facebook"), "reel")).toEqual({
      facebook: { type: "reel" },
    });
  });
});

describe("whether a first comment can go with a post", () => {
  it("is not asked when there is none", () => {
    expect(firstCommentError(on("twitter"), "post", undefined)).toBeUndefined();
    expect(
      firstCommentError(on("instagram"), "story", undefined),
    ).toBeUndefined();
  });

  it.each([
    "instagram",
    "facebook",
    "linkedin",
  ] as const)("takes one on a %s post", (service) => {
    expect(firstCommentError(on(service), "post", "Link")).toBeUndefined();
  });

  it.each([
    "threads",
    "bluesky",
    "mastodon",
    "twitter",
  ] as const)("refuses one on %s, which has no such field in Buffer", (service) => {
    expect(firstCommentError(on(service), "post", "Link")).toBe(
      "This channel takes no first comment.",
    );
  });

  it("takes one on an Instagram reel", () => {
    expect(firstCommentError(on("instagram"), "reel", "Link")).toBeUndefined();
  });

  it("refuses one on a Facebook reel, which Buffer publishes without it", () => {
    expect(firstCommentError(on("facebook"), "reel", "Link")).toBe(
      "A reel on this channel takes no first comment.",
    );
  });

  it("refuses one on a story", () => {
    expect(firstCommentError(on("instagram"), "story", "Link")).toBe(
      "A story has no first comment.",
    );
  });

  it.each([
    ["instagram", 2200],
    ["facebook", 5000],
    ["linkedin", 1250],
  ] as const)("keeps to Buffer's limit on %s: %i", (service, limit) => {
    expect(
      firstCommentError(on(service), "post", "x".repeat(limit)),
    ).toBeUndefined();
    expect(firstCommentError(on(service), "post", "x".repeat(limit + 1))).toBe(
      `The first comment on this channel is at most ${limit} characters.`,
    );
  });

  it("counts an emoji as two characters, as Buffer does", () => {
    const emoji = "\u{1F517}";
    expect(emoji.length).toBe(2);
    expect(
      firstCommentError(on("linkedin"), "post", emoji.repeat(625)),
    ).toBeUndefined();
    expect(
      firstCommentError(on("linkedin"), "post", `${emoji.repeat(625)}x`),
    ).toMatch(/at most 1250/);
  });
});
