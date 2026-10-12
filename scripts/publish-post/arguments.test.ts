// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_URL, parseArguments, resolveBaseUrl } from "./arguments.mjs";
import { ClientError } from "./errors.mjs";

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
