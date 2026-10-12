// @vitest-environment node
import { describe, expect, it } from "vitest";
import { channelContent, selectChannels, selectsChannel } from "./channels.mjs";

const channels = [
  { id: "li1", name: "Foundation LinkedIn", service: "linkedin" },
  { id: "fb1", name: "Foundation Facebook", service: "facebook" },
  { id: "ig1", name: "Foundation Instagram", service: "instagram" },
];

describe("selectChannels", () => {
  const empty = { channelText: {}, channelTextFile: {}, channelImage: {} };

  describe("when the job names no channels", () => {
    it("takes every channel of the session", () => {
      expect(selectChannels(empty, channels)).toEqual(channels);
    });
  });

  describe("when the job names networks and ids", () => {
    it("takes the matching channels in the session's order, each once", () => {
      expect(
        selectChannels(
          { ...empty, channels: ["instagram", "li1", "linkedin"] },
          channels,
        ).map((channel) => channel.id),
      ).toEqual(["li1", "ig1"]);
    });

    it("takes every channel of a network", () => {
      const two = [
        ...channels,
        { id: "li2", name: "Second LinkedIn", service: "linkedin" },
      ];
      expect(
        selectChannels({ ...empty, channels: ["linkedin"] }, two).map(
          (channel) => channel.id,
        ),
      ).toEqual(["li1", "li2"]);
    });

    it("accepts variants of the selected channels", () => {
      expect(
        selectChannels(
          {
            channels: ["instagram", "facebook"],
            channelText: { ig1: "a" },
            channelTextFile: { facebook: "b.txt" },
            channelImage: { instagram: "c.png" },
          },
          channels,
        ),
      ).toHaveLength(2);
    });
  });

  describe("when a name matches nothing", () => {
    it("says which names and what the session has", () => {
      const select = () =>
        selectChannels(
          {
            channels: ["linkedin", "tiktok"],
            channelText: { instagram: "a" },
            channelTextFile: { constructor: "b.txt" },
            channelImage: { linkedn: "c.png" },
          },
          channels,
        );
      expect(select).toThrow(
        'channels: "tiktok" is not a channel of this session; channelText: "instagram" matches no selected channel; channelTextFile: "constructor" matches no selected channel; channelImage: "linkedn" matches no selected channel. The session has: linkedin (li1), facebook (fb1), instagram (ig1).',
      );
      expect(select).toThrow(
        expect.objectContaining({ code: "unknown-channel" }),
      );
    });
  });

  describe("when a channel of an earlier send left the session", () => {
    const left = [{ id: "th1", service: "threads" }];

    it.each([
      [{ channels: ["threads", "linkedin"] }],
      [{ channels: ["th1", "linkedin"] }],
      [{ channels: ["th1", "linkedin"], channelText: { threads: "a" } }],
      [{ channelImage: { th1: "c.png" } }],
    ])("takes %j for no mistake and never selects that channel", (job) => {
      const selected = selectChannels({ ...empty, ...job }, channels, left);
      expect(selected.map((channel) => channel.id)).not.toContain("th1");
      expect(selected.map((channel) => channel.id)).toContain("li1");
    });

    it("still refuses its text when the job no longer means the channel", () => {
      expect(() =>
        selectChannels(
          { ...empty, channels: ["linkedin"], channelText: { threads: "a" } },
          channels,
          left,
        ),
      ).toThrow('channelText: "threads" matches no selected channel');
    });

    it("still refuses a name that neither the session nor that send knows", () => {
      expect(() =>
        selectChannels({ ...empty, channels: ["tiktok"] }, channels, left),
      ).toThrow('channels: "tiktok" is not a channel of this session');
    });
  });

  describe("selectsChannel", () => {
    it.each([
      [undefined, true],
      [["threads"], true],
      [["th1"], true],
      [["linkedin"], false],
    ])("with channels %j says %s", (wanted, expected) => {
      expect(
        selectsChannel({ channels: wanted }, { id: "th1", service: "threads" }),
      ).toBe(expected);
    });

    it("matches a channel without a known network by its ID only", () => {
      expect(selectsChannel({ channels: ["th1"] }, { id: "th1" })).toBe(true);
      expect(selectsChannel({ channels: ["threads"] }, { id: "th1" })).toBe(
        false,
      );
    });
  });

  describe("when the session lists a channel twice", () => {
    const twice = [...channels, { ...channels[0], name: "Listed again" }];

    it("refuses the session as a whole, naming the id once", () => {
      const select = () =>
        selectChannels(empty, [...twice, { ...channels[0], name: "A third" }]);
      expect(select).toThrow(
        "The session lists a channel more than once: li1. Nothing is sent until the Worker's channel list is fixed.",
      );
      expect(select).toThrow(
        expect.objectContaining({ code: "duplicate-channel" }),
      );
    });

    it.each([
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ])("refuses a session with the channel ID %s, a name every object inherits", (id) => {
      const select = () =>
        selectChannels(empty, [...channels, { ...channels[0], id }]);
      expect(select).toThrow(
        `The session lists a channel whose ID cannot be a key of the state file: ${id}. Nothing is sent until the Worker's channel list is fixed.`,
      );
      expect(select).toThrow(
        expect.objectContaining({ code: "unusable-channel" }),
      );
    });

    it("refuses it also when the job does not select that channel", () => {
      expect(() =>
        selectChannels({ ...empty, channels: ["instagram"] }, twice),
      ).toThrow(expect.objectContaining({ code: "duplicate-channel" }));
    });
  });
});

describe("channelContent", () => {
  const content = {
    text: "Default",
    image: "square.png",
    channelText: { instagram: "For Instagram", ig1: "For this channel" },
    channelImage: { instagram: "portrait.png" },
  };

  describe("when the job has a variant for the channel", () => {
    it("prefers the channel id over the network", () => {
      expect(channelContent(content, channels[2])).toEqual({
        text: "For this channel",
        image: "portrait.png",
      });
    });
  });

  describe("when it has none", () => {
    it("uses the job's text and image", () => {
      expect(channelContent(content, channels[0])).toEqual({
        text: "Default",
        image: "square.png",
      });
    });

    it("is not fooled by names every object has", () => {
      expect(
        channelContent(content, {
          id: "constructor",
          name: "Odd",
          service: "toString",
        }),
      ).toEqual({ text: "Default", image: "square.png" });
    });
  });
});
