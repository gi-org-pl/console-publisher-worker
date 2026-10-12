// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  clientSecret,
  instagram,
  linkedin,
  script,
  seen,
  standIn,
  token,
  useWorkerStandIn,
} from "./workerStandIn";

useWorkerStandIn();

describe("check", () => {
  describe("when the token is valid", () => {
    it("prints the service and its channels after one request", async () => {
      const { exitCode, document } = await script(["check"]);
      expect(exitCode).toBe(0);
      expect(document).toEqual({
        ok: true,
        command: "check",
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(seen).toHaveLength(1);
    });
  });

  describe("when Access refuses the token", () => {
    it("reports the refusal and its status", async () => {
      const { exitCode, document } = await script(["check"], {
        env: { ...token, CF_ACCESS_CLIENT_SECRET: `${clientSecret}0` },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
    });
  });

  describe("when the answer is not the Worker's", () => {
    it.each([
      [
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.org/login" },
          }),
        302,
        "The Console answered 302 without a message.",
      ],
      [
        () => new Response("<html>", { status: 502 }),
        502,
        "The Console answered 502 without a message.",
      ],
      [
        () => Response.json({ service: "gieniek-bot" }),
        200,
        "The session answer is not what the Worker's schema describes.",
      ],
    ])("reports it and sends nothing else", async (response, status, message) => {
      standIn.answer = response;
      const { document } = await script(["check"]);
      expect(document.errors).toEqual([
        { code: "session-failed", status, message },
      ]);
      expect(seen).toHaveLength(1);
    });
  });

  describe("when no answer arrives", () => {
    it("reports it without a status", async () => {
      const { document } = await script(["check"], {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          message: "No answer from the Console: fetch failed.",
        },
      ]);
    });
  });

  describe("when the arguments are wrong", () => {
    it.each([
      [[]],
      [["publish", "post.json"]],
      [["check", "post.json"]],
      [["queue"]],
      [["queue", "post.json", "extra"]],
      [["queue", "post.json", "--credential"]],
      [["queue", "--send"]],
      [["check", "--url", "http://127.0.0.1:9"]],
    ])("answers %j with the usage before anything else", async (argv) => {
      const { exitCode, document } = await script(argv);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "invalid-arguments",
          message: expect.stringMatching(/^Usage: /),
        },
      ]);
      expect(seen).toHaveLength(0);
    });
  });
});
