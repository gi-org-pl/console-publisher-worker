// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  publishInputSchema,
  SERVICE_MODES,
} from "../src/schemas/publishing";
import {
  buildPostRequest,
  buildSessionRequest,
  buildUploadRequest,
  CHECK_BUFFER,
  ClientError,
  CREDENTIAL_NOT_FOUND,
  channelContent,
  checkCredentials,
  checkDueAt,
  checkText,
  classifyPost,
  contentDigest,
  credentialCommand,
  credentialsFromEnvironment,
  DEFAULT_URL,
  defaultStatePath,
  emptyState,
  inspectImage,
  isRefusal,
  MODES,
  normalizeText,
  parseArguments,
  parseCredentialOutput,
  parseJob,
  parseState,
  planEntry,
  redact,
  redactDeep,
  resolveBaseUrl,
  selectChannels,
  serializeState,
  sha256,
} from "./publishJob.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};
const requestId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5df";
const mediaId = "fa7ec4cf-3fb8-475a-85eb-7781ca67f5de";
const digest = "a".repeat(64);
const channels = [
  { id: "li1", name: "Foundation LinkedIn", service: "linkedin" },
  { id: "fb1", name: "Foundation Facebook", service: "facebook" },
  { id: "ig1", name: "Foundation Instagram", service: "instagram" },
];

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

describe("parseArguments", () => {
  describe("when only a command is given", () => {
    it("checks the session at the Console", () => {
      expect(parseArguments(["check"])).toEqual({
        command: "check",
        job: undefined,
        send: false,
        state: undefined,
        url: DEFAULT_URL,
        credential: undefined,
      });
    });

    it("prepares a dry run of a job", () => {
      expect(parseArguments(["queue", "post.json"])).toMatchObject({
        command: "queue",
        job: "post.json",
        send: false,
      });
    });
  });

  describe("when options are given", () => {
    it("reads them in any order", () => {
      expect(
        parseArguments([
          "--url",
          "http://localhost:8787",
          "schedule",
          "--send",
          "post.json",
          "--state",
          "run.json",
          "--credential",
          "console",
        ]),
      ).toEqual({
        command: "schedule",
        job: "post.json",
        send: true,
        state: "run.json",
        url: "http://localhost:8787",
        credential: "console",
      });
    });
  });

  describe("when the arguments are wrong", () => {
    it.each([
      [[], /^Usage: node scripts\/publishPost\.mjs check/],
      [["shareNow", "post.json"], /^Unknown command shareNow\. Usage/],
      [["queue"], /^queue needs a job file\. Usage/],
      [["queue", "a.json", "b.json"], /^Unexpected argument b\.json\.$/],
      [["check", "a.json"], /^Unexpected argument a\.json\.$/],
      [["check", "--send"], /^check takes neither --send nor --state\.$/],
      [["check", "--state", "s.json"], /^check takes neither/],
      [["queue", "a.json", "--state"], /^--state needs a value\.$/],
      [["queue", "a.json", "--url", "--send"], /^--url needs a value\.$/],
      [["queue", "a.json", "--now"], /^Unknown option --now\.$/],
    ])("rejects %j", (argv, message) => {
      expect(() => parseArguments(argv)).toThrow(message);
      expect(() => parseArguments(argv)).toThrow(ClientError);
    });
  });
});

describe("resolveBaseUrl", () => {
  describe("when the address is the Console or this machine", () => {
    it.each([
      ["https://console.gi.org.pl", "https://console.gi.org.pl"],
      ["https://console.gi.org.pl/", "https://console.gi.org.pl"],
      ["http://localhost:8787", "http://localhost:8787"],
      ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
      ["https://[::1]:8787", "https://[::1]:8787"],
    ])("accepts %s", (value, origin) => {
      expect(resolveBaseUrl(value)).toBe(origin);
    });
  });

  describe("when the credentials would go somewhere else", () => {
    it.each([
      ["https://console.gi.org.pl.example.org", /^--url may only be/],
      ["http://console.gi.org.pl", /^--url may only be/],
      ["https://example.org", /^--url may only be/],
      ["ftp://localhost", /^--url may only be/],
      ["https://console.gi.org.pl/api", /^--url takes an origin only/],
      ["http://localhost:8787/?a=1", /^--url takes an origin only/],
      ["http://localhost:8787/#x", /^--url takes an origin only/],
      ["http://user:pass@localhost:8787", /^--url takes an origin only/],
      ["http://user@localhost:8787", /^--url takes an origin only/],
      ["localhost", /^--url is not a URL\.$/],
    ])("rejects %s", (value, message) => {
      expect(() => resolveBaseUrl(value)).toThrow(message);
    });
  });
});

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

describe("contentDigest", () => {
  const content = {
    mode: "customScheduled",
    dueAt: "2026-10-20T07:00:00.000Z",
    text: "Hello",
    imageSha256: sha256(png()),
  };

  describe("when nothing changed", () => {
    it("is the same", () => {
      expect(contentDigest({ ...content })).toBe(contentDigest(content));
      expect(contentDigest(content)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("when anything that is sent changed", () => {
    it.each([
      [{ mode: "addToQueue" }],
      [{ dueAt: "2026-10-20T08:00:00.000Z" }],
      [{ dueAt: undefined }],
      [{ text: "Hello!" }],
      [{ imageSha256: sha256(png(1080, 1080)) }],
    ])("differs for %j", (change) => {
      expect(contentDigest({ ...content, ...change })).not.toBe(
        contentDigest(content),
      );
    });
  });
});

describe("credentialsFromEnvironment", () => {
  describe("when both variables are set", () => {
    it("returns the pair", () => {
      expect(
        credentialsFromEnvironment({
          CF_ACCESS_CLIENT_ID: credentials.clientId,
          CF_ACCESS_CLIENT_SECRET: credentials.clientSecret,
        }),
      ).toEqual(credentials);
    });
  });

  describe("when one is missing or empty", () => {
    it.each([
      [{}],
      [{ CF_ACCESS_CLIENT_ID: credentials.clientId }],
      [{ CF_ACCESS_CLIENT_SECRET: credentials.clientSecret }],
      [
        {
          CF_ACCESS_CLIENT_ID: "",
          CF_ACCESS_CLIENT_SECRET: credentials.clientSecret,
        },
      ],
    ])("returns nothing for %j", (env) => {
      expect(credentialsFromEnvironment(env)).toBeUndefined();
    });
  });
});

describe("checkCredentials", () => {
  describe("when the pair looks like a service token", () => {
    it("returns it", () => {
      expect(checkCredentials(credentials, "the environment")).toBe(
        credentials,
      );
    });
  });

  describe("when it cannot be one", () => {
    it.each([
      [
        { clientId: credentials.clientSecret, clientSecret: "swapped-pair" },
        /^The Client ID from the environment is not a service token Client ID/,
      ],
      [
        { ...credentials, clientSecret: "" },
        /^The Client Secret from the environment is empty or holds/,
      ],
      [
        { ...credentials, clientSecret: "two words" },
        /^The Client Secret from the environment is empty or holds/,
      ],
      [
        { ...credentials, clientSecret: "line\r\nbreak" },
        /^The Client Secret from the environment is empty or holds/,
      ],
    ])("refuses it without repeating a value", (pair, message) => {
      const check = () => checkCredentials(pair, "the environment");
      expect(check).toThrow(message);
      expect(check).toThrow(
        expect.objectContaining({ code: "invalid-credentials" }),
      );
      try {
        check();
      } catch (cause) {
        const text = (cause as Error).message;
        expect(text).not.toContain(pair.clientId);
        if (pair.clientSecret) expect(text).not.toContain(pair.clientSecret);
      }
    });
  });
});

describe("credentialCommand", () => {
  describe("when a credential is named", () => {
    it("starts PowerShell without a profile and passes the name in the environment", () => {
      const command = credentialCommand("console'; Remove-Item x");
      expect(command.file).toBe("powershell");
      expect(command.args.slice(0, 3)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      expect(command.env).toEqual({
        PUBLISH_POST_CREDENTIAL: "console'; Remove-Item x",
      });

      const script = Buffer.from(command.args[3], "base64").toString("utf16le");
      expect(script).not.toContain("Remove-Item");
      expect(script).toContain("CredRead($env:PUBLISH_POST_CREDENTIAL, 1, 0,");
      expect(script).toContain(`{ exit ${CREDENTIAL_NOT_FOUND} }`);
      // A here-string ends only at the start of a line.
      expect(script).toMatch(/\n'@\n/);
    });
  });
});

describe("parseCredentialOutput", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64");

  describe("when the script printed a credential", () => {
    it("returns the user name as Client ID and the password as Client Secret", () => {
      expect(parseCredentialOutput(`${encode(credentials)}\r\n`)).toEqual(
        credentials,
      );
    });
  });

  describe("when the output is something else", () => {
    it.each([
      [""],
      ["not base64 JSON"],
      [encode({ clientId: credentials.clientId })],
      [encode({ clientId: 1, clientSecret: credentials.clientSecret })],
      [encode(null)],
    ])("reports it without quoting the output", (stdout) => {
      const parse = () => parseCredentialOutput(stdout);
      expect(parse).toThrow(
        /^The answer of the credential store could not be read\.$/,
      );
      expect(parse).toThrow(
        expect.objectContaining({ code: "credential-unavailable" }),
      );
    });
  });
});

describe("redact and redactDeep", () => {
  const secrets = [credentials.clientSecret, credentials.clientId];

  describe("when a text carries a credential", () => {
    it("replaces every occurrence", () => {
      expect(
        redact(
          `id ${credentials.clientId}, secret ${credentials.clientSecret}${credentials.clientSecret}`,
          secrets,
        ),
      ).toBe("id [redacted], secret [redacted][redacted]");
    });

    it("leaves other text alone and ignores an empty secret", () => {
      expect(redact("nothing to hide", ["", ...secrets])).toBe(
        "nothing to hide",
      );
    });
  });

  describe("when a document carries one anywhere", () => {
    it("cleans values and keys and keeps the rest", () => {
      expect(
        redactDeep(
          {
            ok: false,
            count: 2,
            nothing: null,
            errors: [{ message: `bad ${credentials.clientSecret}` }],
            [credentials.clientSecret]: { step: "posting" },
          },
          secrets,
        ),
      ).toEqual({
        ok: false,
        count: 2,
        nothing: null,
        errors: [{ message: "bad [redacted]" }],
        "[redacted]": { step: "posting" },
      });
    });
  });
});

describe("the requests", () => {
  const headers = {
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  };
  const input = {
    requestId,
    mediaId,
    channelId: "li1",
    text: "Hello",
    mode: MODES.queue,
  };

  describe("when the session is asked for", () => {
    it("sends the two Access headers and nothing else", () => {
      expect(buildSessionRequest(credentials)).toEqual({
        method: "GET",
        path: "/api/buffer/session",
        headers,
      });
    });
  });

  describe("when an image is uploaded", () => {
    it("sends the bytes as image/png", () => {
      const bytes = png();
      expect(buildUploadRequest(credentials, bytes)).toEqual({
        method: "POST",
        path: "/api/buffer/media",
        headers: { ...headers, "Content-Type": "image/png" },
        body: bytes,
      });
    });
  });

  describe("when a post is queued or scheduled", () => {
    it("sends exactly the fields of the Worker's schema", () => {
      const request = buildPostRequest(credentials, input);
      expect(request).toMatchObject({
        method: "POST",
        path: "/api/buffer/posts",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      expect(JSON.parse(request.body)).toEqual(input);
      expect(publishInputSchema.parse(JSON.parse(request.body))).toEqual(input);
    });

    it("adds the time of a scheduled post", () => {
      const scheduled = {
        ...input,
        mode: MODES.schedule,
        dueAt: "2026-10-20T07:00:00.000Z",
      };
      expect(JSON.parse(buildPostRequest(credentials, scheduled).body)).toEqual(
        scheduled,
      );
    });

    it("never sends an Origin header", () => {
      for (const request of [
        buildSessionRequest(credentials),
        buildUploadRequest(credentials, png()),
        buildPostRequest(credentials, input),
      ])
        expect(
          Object.keys(request.headers).map((name) => name.toLowerCase()),
        ).not.toContain("origin");
    });
  });

  describe("when the request would not pass the Worker", () => {
    it.each([
      [{ mode: "shareNow" }, /^Mode shareNow is not offered\.$/],
      [{ requestId: "1" }, /does not match the Worker's schema: requestId: /],
      [{ text: "" }, /does not match the Worker's schema: text: /],
      [{ extra: true }, /does not match the Worker's schema: : Unrecognized/],
    ])("refuses to build %j", (change, message) => {
      expect(() =>
        buildPostRequest(credentials, { ...input, ...change }),
      ).toThrow(message);
    });
  });

  describe("when the modes are compared with the Worker's", () => {
    it("offers a service exactly the modes it may use", () => {
      expect(Object.values(MODES).sort()).toEqual([...SERVICE_MODES].sort());
      expect(Object.keys(MODES)).toEqual(["queue", "schedule"]);
    });
  });
});

describe("isRefusal and classifyPost", () => {
  describe("when the Worker created the post", () => {
    it("reports the post ID", () => {
      expect(
        classifyPost({ status: 200, data: { postId: "p1" }, message: "" }),
      ).toEqual({ outcome: "created", postId: "p1" });
    });
  });

  describe("when the Worker or Access turned the request down", () => {
    it.each([
      302, 400, 401, 403, 404, 405, 413, 415, 429,
    ])("reports %i as refused with the message", (status) => {
      expect(isRefusal(status)).toBe(true);
      expect(
        classifyPost({ status, data: { message: "No." }, message: "No." }),
      ).toEqual({ outcome: "refused", status, message: "No." });
    });
  });

  describe("when nothing says whether a post exists", () => {
    it.each([
      0, 200, 204, 409, 500, 502, 503,
    ])("reports %i as unknown and points to Buffer", (status) => {
      expect(isRefusal(status)).toBe(false);
      const result = classifyPost({ status, data: {}, message: "Hm." });
      expect(result).toMatchObject({ outcome: "unknown", status });
      expect((result as { message: string }).message).toContain(CHECK_BUFFER);
    });
  });
});

describe("the state", () => {
  const entry = { requestId, digest, step: "prepared" as const };
  const origin = "https://console.gi.org.pl";

  describe("when a state is written and read back", () => {
    it("is the same state", () => {
      const state = {
        version: 1 as const,
        origin: "https://console.gi.org.pl",
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
      [JSON.stringify({ version: 1, origin: 1, channels: {} }), /origin: /],
      [JSON.stringify({ version: 1, origin: "", channels: {} }), /origin: /],
      [
        JSON.stringify({
          version: 1,
          origin,
          channels: { li1: { requestId } },
        }),
        /channels\.li1\.digest: /,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          channels: { li1: { ...entry, step: "sent" } },
        }),
        /channels\.li1\.step: /,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
          channels: { li1: { ...entry, step: "created" } },
        }),
        /channels\.li1: a "created" entry needs a postId/,
      ],
      [
        JSON.stringify({
          version: 1,
          origin,
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
    it.each([
      digest,
      other,
    ])("is never repeated, whatever the job says now", (current) => {
      const posting = { ...entry, step: "posting" as const, mediaId };
      expect(planEntry(posting, current, newId)).toEqual({
        action: "unknown",
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
