// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  publishInputSchema,
} from "../../src/schemas/publishing";
import {
  checkDueAt,
  checkText,
  defaultStatePath,
  inspectImage,
  normalizeText,
  parseJob,
} from "./job.mjs";

function png(width = 1080, height = 1350, length = 24) {
  const bytes = new Uint8Array(length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function job(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ text: "Hello", image: "post.png", ...extra });
}

describe("defaultStatePath", () => {
  describe("when the job is a JSON file", () => {
    it("puts the state next to it", () => {
      expect(defaultStatePath("posts/launch.json")).toBe(
        "posts/launch.state.json",
      );
      expect(defaultStatePath("LAUNCH.JSON")).toBe("LAUNCH.state.json");
    });
  });

  describe("when the job has another name", () => {
    it("appends the suffix", () => {
      expect(defaultStatePath("launch")).toBe("launch.state.json");
    });
  });
});

describe("normalizeText and checkText", () => {
  describe("when the text comes from a Windows editor", () => {
    it("drops the byte order mark, the carriage returns and the outer space", () => {
      expect(normalizeText("﻿  One\r\nTwo\rThree\n\n")).toBe("One\nTwo\nThree");
      expect(checkText(" One\r\nTwo ", "text")).toBe("One\nTwo");
    });
  });

  describe("when the text is outside the Worker's limits", () => {
    it.each([
      [" \r\n ", /^text: Too small/],
      ["x".repeat(5001), /^text: Too big/],
    ])("rejects it", (text, message) => {
      expect(() => checkText(text, "text")).toThrow(message);
    });

    it("accepts what the Worker's schema accepts", () => {
      const text = checkText(`${"x".repeat(5000)}\r\n`, "text");
      expect(text).toHaveLength(5000);
      expect(publishInputSchema.shape.text.safeParse(text).success).toBe(true);
    });
  });
});

describe("inspectImage", () => {
  describe("when the bytes are a PNG the Worker accepts", () => {
    it("reads its size", () => {
      expect(inspectImage(png(), "image")).toEqual({
        width: 1080,
        height: 1350,
      });
      expect(inspectImage(png(4096, 1), "image")).toEqual({
        width: 4096,
        height: 1,
      });
    });

    it("reads a view into a larger buffer", () => {
      const padded = new Uint8Array(40);
      padded.set(png(600, 400), 8);
      expect(inspectImage(padded.subarray(8, 32), "image")).toEqual({
        width: 600,
        height: 400,
      });
    });
  });

  describe("when the Worker would refuse the upload", () => {
    const noHeader = png();
    noHeader.set(new TextEncoder().encode("IDAT"), 12);
    it.each([
      ["too short", png().subarray(0, 23), /^image: not a PNG file\.$/],
      ["another format", new Uint8Array(24), /^image: not a PNG file\.$/],
      ["a PNG without IHDR", noHeader, /^image: not a PNG file\.$/],
      ["too wide", png(4097, 100), /^image: 4097x100 px, but each side/],
      ["flat", png(100, 0), /^image: 100x0 px, but each side/],
      [
        "too large",
        png(100, 100, MAX_IMAGE_BYTES + 1),
        /^image: the image must be at most 5 MB\.$/,
      ],
    ])("rejects an image that is %s", (_, bytes, message) => {
      expect(() => inspectImage(bytes, "image")).toThrow(message);
    });
  });
});

describe("parseJob", () => {
  describe("when the job is minimal", () => {
    it("posts one text and one image to every channel", () => {
      expect(parseJob(job(), "queue")).toEqual({
        text: "Hello",
        image: "post.png",
        channelText: {},
        channelTextFile: {},
        channelImage: {},
      });
    });

    it("reads a file saved with a byte order mark", () => {
      expect(parseJob(`﻿${job()}`, "queue").text).toBe("Hello");
    });
  });

  describe("when the job is complete", () => {
    it("keeps the variants and converts the time to UTC", () => {
      expect(
        parseJob(
          JSON.stringify({
            textFile: "post.txt",
            image: "square.png",
            channels: ["linkedin", "ig1"],
            channelText: { instagram: "Shorter" },
            channelTextFile: { linkedin: "linkedin.txt" },
            channelImage: { ig1: "portrait.png" },
            dueAt: "2026-10-20T09:00:00+02:00",
          }),
          "schedule",
        ),
      ).toEqual({
        textFile: "post.txt",
        image: "square.png",
        channels: ["linkedin", "ig1"],
        channelText: { instagram: "Shorter" },
        channelTextFile: { linkedin: "linkedin.txt" },
        channelImage: { ig1: "portrait.png" },
        dueAt: "2026-10-20T07:00:00.000Z",
      });
    });

    it("sends a time the Worker's schema accepts", () => {
      const { dueAt } = parseJob(
        job({ dueAt: "2026-10-20T09:00:00.5-03:30" }),
        "schedule",
      );
      expect(dueAt).toBe("2026-10-20T12:30:00.500Z");
      expect(publishInputSchema.shape.dueAt.safeParse(dueAt).success).toBe(
        true,
      );
    });
  });

  describe("when the job is malformed", () => {
    it.each([
      ["{", "queue", /^The job is not valid JSON/],
      ["[]", "queue", /expected object/],
      ['{"text":"Hello"}', "queue", /^image: /],
      [job({ mode: "shareNow" }), "queue", /Unrecognized key/],
      [job({ channels: [] }), "queue", /^channels: /],
      [job({ channels: [""] }), "queue", /^channels\.0: /],
      [job({ channelText: { instagram: 1 } }), "queue", /^channelText\./],
      [job({ channelImage: { instagram: "" } }), "queue", /^channelImage\./],
      [job({ textFile: "post.txt" }), "queue", /^Give either "text" or/],
      ['{"image":"post.png"}', "queue", /^Give either "text" or "textFile"/],
      [
        job({
          channelText: { instagram: "a", li1: "b" },
          channelTextFile: { instagram: "a.txt" },
        }),
        "queue",
        /^"channelText" and "channelTextFile" both name instagram\.$/,
      ],
      [job(), "schedule", /^schedule needs "dueAt"/],
      [
        job({ dueAt: "2026-10-20T09:00:00+02:00" }),
        "queue",
        /^queue takes no "dueAt"/,
      ],
      [job({ dueAt: "2026-10-20T09:00:00" }), "schedule", /^dueAt: /],
      [job({ dueAt: "tomorrow" }), "schedule", /^dueAt: /],
    ])("rejects %s for %s", (input, command, message) => {
      expect(() => parseJob(input, command)).toThrow(message);
    });
  });
});

describe("checkDueAt", () => {
  const now = Date.parse("2026-10-12T10:00:00Z");

  describe("when the time is inside the Worker's window", () => {
    it.each([
      "2026-10-12T10:00:01.000Z",
      "2026-11-11T10:00:00.000Z",
    ])("accepts %s", (dueAt) => {
      expect(() => checkDueAt(dueAt, now)).not.toThrow();
    });
  });

  describe("when the time is outside it", () => {
    it.each([
      ["2026-10-12T10:00:00.000Z", /is not in the future\.$/],
      ["2026-10-11T10:00:00.000Z", /is not in the future\.$/],
      ["2026-11-11T10:00:01.000Z", /is more than 30 days from now\.$/],
    ])("rejects %s", (dueAt, message) => {
      expect(() => checkDueAt(dueAt, now)).toThrow(message);
    });
  });
});
