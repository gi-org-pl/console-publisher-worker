import { describe, expect, it } from "vitest";
import { channelMetadata, firstCommentError } from "./buffer";
import type { Channel } from "./types";

const on = (service: Channel["service"]): Channel => ({
  id: "c1",
  name: "Channel",
  service,
});

describe("the metadata Buffer gets for a channel", () => {
  it("carries the first comment for Instagram, next to the post type", () => {
    expect(channelMetadata(on("instagram"), "post", "Link: x.org")).toEqual({
      instagram: {
        type: "post",
        shouldShareToFeed: true,
        firstComment: "Link: x.org",
      },
    });
  });

  it("carries the first comment for Facebook, next to the post type", () => {
    expect(channelMetadata(on("facebook"), "post", "Link: x.org")).toEqual({
      facebook: { type: "post", firstComment: "Link: x.org" },
    });
  });

  it("carries the first comment for LinkedIn, which needs no type", () => {
    expect(channelMetadata(on("linkedin"), "post", "Link: x.org")).toEqual({
      linkedin: { firstComment: "Link: x.org" },
    });
  });

  it("stays what it was without a first comment", () => {
    expect(channelMetadata(on("instagram"), "post")).toEqual({
      instagram: { type: "post", shouldShareToFeed: true },
    });
    expect(channelMetadata(on("instagram"), "story")).toEqual({
      instagram: { type: "story", shouldShareToFeed: false },
    });
    expect(channelMetadata(on("facebook"), "post")).toEqual({
      facebook: { type: "post" },
    });
    for (const service of [
      "linkedin",
      "threads",
      "bluesky",
      "mastodon",
      "twitter",
    ] as const) {
      expect(channelMetadata(on(service), "post")).toBeUndefined();
    }
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
