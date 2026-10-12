// @vitest-environment node
import { describe, expect, it } from "vitest";
import { emptyState, parseState, planEntry, serializeState } from "./state.mjs";

const requestId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df";
const mediaId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5de";
const digest = "a".repeat(64);

describe("the state", () => {
  const entry = { requestId, digest, step: "prepared" as const };
  const origin = "https://console.gi.org.pl";

  describe("when a state is written and read back", () => {
    it("is the same state", () => {
      const state = {
        version: 1 as const,
        origin: "https://console.gi.org.pl",
        targets: ["li1", "fb1", "ig1"],
        channels: {
          li1: { ...entry, service: "linkedin", step: "created", postId: "p1" },
          fb1: {
            ...entry,
            step: "refused",
            status: 403,
            message: "This channel is not allowed.",
          },
          ig1: { ...entry, step: "uploaded", mediaId },
        },
      };
      const text = serializeState(state);
      expect(text.endsWith("}\n")).toBe(true);
      expect(parseState(text)).toEqual(state);
      expect(
        parseState(serializeState(emptyState("https://console.gi.org.pl"))),
      ).toEqual({
        version: 1,
        origin: "https://console.gi.org.pl",
        targets: null,
        channels: {},
      });
    });
  });

  describe("when the file is not a state of this client", () => {
    it.each([
      ["", /^The state file is not valid JSON/],
      ["{}", /^The state file is not a state of this client: version: /],
      ['{"version":2,"channels":{}}', /version: /],
      // A state without the address of its Worker, as an early build wrote it.
      [
        '{"version":1,"channels":{}}',
        /^The state file is not a state of this client: origin: /,
      ],
      [
        JSON.stringify({ version: 1, origin: 1, targets: null, channels: {} }),
        /origin: /,
      ],
      [
        JSON.stringify({ version: 1, origin: "", targets: null, channels: {} }),
        /origin: /,
      ],
      // A state that does not say which channels its job was sent to.
      [
        JSON.stringify({ version: 1, origin, channels: {} }),
        /^The state file is not a state of this client: targets: /,
      ],
      [
        JSON.stringify({ version: 1, origin, targets: "li1", channels: {} }),
        /targets: /,
      ],
      [
        JSON.stringify({ version: 1, origin, targets: [""], channels: {} }),
        /targets\.0: /,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          targets: null,
          channels: { li1: { requestId } },
        }),
        /channels\.li1\.digest: /,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          targets: null,
          channels: { li1: { ...entry, step: "sent" } },
        }),
        /channels\.li1\.step: /,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          targets: null,
          channels: { li1: { ...entry, step: "created" } },
        }),
        /channels\.li1: a "created" entry needs a postId/,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          targets: null,
          channels: { li1: { ...entry, clientSecret: "x" } },
        }),
        /Unrecognized key/,
      ],
    ])("refuses %s", (input, message) => {
      const parse = () => parseState(input);
      expect(parse).toThrow(message);
      expect(parse).toThrow(expect.objectContaining({ code: "invalid-state" }));
    });
  });
});

describe("planEntry", () => {
  const newId = () => requestId;
  const other = "b".repeat(64);
  const entry = { requestId, digest, step: "prepared" as const };

  describe("when the channel is new", () => {
    it("prepares a request ID for it", () => {
      expect(planEntry(undefined, digest, newId)).toEqual({
        action: "send",
        entry: { requestId, digest, step: "prepared" },
      });
    });
  });

  describe("when the post exists", () => {
    const created = { ...entry, step: "created" as const, postId: "p1" };

    it("is not sent again for the same content", () => {
      expect(planEntry(created, digest, newId)).toEqual({
        action: "already-created",
        entry: created,
      });
    });

    it("is flagged when the job changed since", () => {
      expect(planEntry(created, other, newId).action).toBe("changed");
    });
  });

  describe("when an earlier post request has no recorded result", () => {
    const posting = { ...entry, step: "posting" as const, mediaId };

    it("is never repeated", () => {
      expect(planEntry(posting, digest, newId)).toEqual({
        action: "unknown",
        entry: posting,
      });
    });

    it("is flagged when the job changed since, and not repeated either", () => {
      expect(planEntry(posting, other, newId)).toEqual({
        action: "changed",
        entry: posting,
      });
    });
  });

  describe("when nothing was created yet", () => {
    it.each([
      "prepared",
      "uploading",
      "uploaded",
      "refused",
      "failed",
    ] as const)("sends a %s channel with its request ID", (step) => {
      const earlier = { ...entry, step, mediaId, status: 403, message: "No." };
      expect(planEntry(earlier, digest, () => "unused")).toEqual({
        action: "send",
        entry: earlier,
      });
    });

    it("starts over when the job changed, keeping the request ID", () => {
      expect(
        planEntry(
          { ...entry, step: "uploaded", mediaId },
          other,
          () => "unused",
        ),
      ).toEqual({
        action: "send",
        entry: { requestId, digest: other, step: "prepared" },
      });
    });
  });
});
