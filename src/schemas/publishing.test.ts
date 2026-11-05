import { describe, expect, it } from "vitest";
import { MAX_FIRST_COMMENT, publishInputSchema } from "./publishing";

const post = {
  requestId: "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df",
  mediaId: "fa7ec4cf-3fb8-475a-85eb-7781ca67f5de",
  channelId: "allowed",
  text: "Hello",
  mode: "addToQueue",
};

describe("the first comment of a post", () => {
  it("is optional, and a post without one parses to the same object as before", () => {
    const parsed = publishInputSchema.parse(post);
    expect(parsed).toEqual(post);
    expect(parsed).not.toHaveProperty("firstComment");
  });

  it("is trimmed like the text", () => {
    expect(
      publishInputSchema.parse({ ...post, firstComment: "  Link: x.org \n" })
        .firstComment,
    ).toBe("Link: x.org");
  });

  it(`takes up to ${MAX_FIRST_COMMENT} characters`, () => {
    const longest = "x".repeat(MAX_FIRST_COMMENT);
    expect(
      publishInputSchema.parse({ ...post, firstComment: longest }).firstComment,
    ).toBe(longest);
  });

  it.each([
    ["an empty comment", ""],
    ["a comment of whitespace only", "  \n "],
    ["a comment that is too long", "x".repeat(MAX_FIRST_COMMENT + 1)],
    ["a comment that is not a string", 42],
  ])("refuses %s", (_name, firstComment) => {
    expect(
      publishInputSchema.safeParse({ ...post, firstComment }).success,
    ).toBe(false);
  });
});
