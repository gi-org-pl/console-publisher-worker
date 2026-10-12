// @vitest-environment node
import { describe, expect, it } from "vitest";
import { run } from "../run.mjs";
import {
  client,
  clientId,
  clientSecret,
  credentials,
  env,
  instagram,
  linkedin,
  localFetch,
  origin,
  outputs,
  seen,
  standIn,
  useWorkerStandIn,
} from "./workerStandIn";

useWorkerStandIn();

describe("check", () => {
  describe("when the credentials are valid", () => {
    it("prints the service and its channels after one request", async () => {
      const { exitCode, document, logs } = await client(["check"]);
      expect(exitCode).toBe(0);
      expect(document).toEqual({
        ok: true,
        command: "check",
        sent: false,
        url: origin,
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(logs).toEqual(["session: 200"]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: "GET",
        path: "/api/buffer/session",
        headers: {
          "cf-access-client-id": clientId,
          "cf-access-client-secret": clientSecret,
        },
      });
    });
  });

  describe("when the credentials are missing", () => {
    it.each([
      [{}, /^Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or pass/],
      [
        { CF_ACCESS_CLIENT_SECRET: clientSecret },
        /\(only CF_ACCESS_CLIENT_SECRET is set\)/,
      ],
      [
        { CF_ACCESS_CLIENT_ID: clientId },
        /\(only CF_ACCESS_CLIENT_ID is set\)/,
      ],
    ])("fails with a clear message and sends nothing", async (vars, message) => {
      const { exitCode, document } = await client(["check"], { env: vars });
      expect(exitCode).toBe(1);
      expect(document).toMatchObject({
        ok: false,
        command: "check",
        identity: null,
        channels: [],
        errors: [{ code: "missing-credentials" }],
      });
      expect(document.errors[0].message).toMatch(message);
      expect(seen).toHaveLength(0);
    });
  });

  describe("when the credentials cannot be a service token", () => {
    it.each([
      [
        {
          CF_ACCESS_CLIENT_ID: clientSecret,
          CF_ACCESS_CLIENT_SECRET: clientId,
        },
      ],
      [{ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: "a b" }],
    ])("refuses them before any request", async (vars) => {
      const { exitCode, document } = await client(["check"], { env: vars });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        expect.objectContaining({ code: "invalid-credentials" }),
      ]);
      expect(seen).toHaveLength(0);
    });
  });

  describe("when the session is refused", () => {
    it("reports what Access says to a wrong secret", async () => {
      const { exitCode, document } = await client(["check"], {
        env: { ...credentials, CF_ACCESS_CLIENT_SECRET: "0".repeat(64) },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
      expect(document.identity).toBeNull();
    });

    it("reports a service token that is not allowlisted", async () => {
      env.SERVICES_JSON = "[]";
      const { document } = await client(["check"]);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 403,
          message: "This service token is not allowed.",
        },
      ]);
    });

    it("does not follow a redirect with the credential headers", async () => {
      standIn.answer = (request) =>
        request.path === "/api/buffer/session"
          ? new Response(null, {
              status: 302,
              headers: { Location: `${origin}/elsewhere` },
            })
          : undefined;
      const { document } = await client(["check"]);
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          status: 302,
          message:
            "Redirected instead of answered: Cloudflare Access did not accept the credentials.",
        },
      ]);
      expect(seen.map((request) => request.path)).toEqual([
        "/api/buffer/session",
      ]);
    });

    it.each([
      [
        new Response("<html>Forbidden</html>", {
          status: 403,
          headers: { "Content-Type": "text/html" },
        }),
        403,
        "HTTP 403 without a message from the Worker.",
      ],
      [
        Response.json(null, { status: 500 }),
        500,
        "HTTP 500 without a message from the Worker.",
      ],
      [
        Response.json({ channels: [] }),
        200,
        "The session answer is not what the Worker's schema describes.",
      ],
    ])("reports an answer that is not the Worker's", async (response, status, message) => {
      standIn.answer = () => response;
      const { exitCode, document } = await client(["check"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "session-failed", status, message },
      ]);
    });
  });

  describe("when no answer arrives", () => {
    it("reports the failure without a status", async () => {
      const { document, logs } = await client(["check"], {
        fetch: async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect"), {
              code: "ECONNREFUSED",
            }),
          });
        },
      });
      expect(document.errors).toEqual([
        {
          code: "session-failed",
          message: `No answer from ${origin}: fetch failed (ECONNREFUSED).`,
        },
      ]);
      expect(logs).toEqual(["session: no answer"]);
    });

    it("gives up after the time limit", async () => {
      const { document } = await client(["check"], {
        timeoutMs: 20,
        fetch: (_: unknown, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      });
      expect(document.errors[0].message).toBe(
        `No answer from ${origin}: no answer within 0.02 s.`,
      );
    });

    it("reports a failure that is not an error object", async () => {
      const { document } = await client(["check"], {
        fetch: async () => {
          throw "socket closed";
        },
      });
      expect(document.errors[0].message).toBe(
        `No answer from ${origin}: socket closed.`,
      );
    });
  });

  describe("when the arguments are wrong", () => {
    it("fails before anything else happens", async () => {
      const { exitCode, document } = await client(["publish"]);
      expect(exitCode).toBe(1);
      expect(document).toMatchObject({
        ok: false,
        command: null,
        errors: [{ code: "invalid-arguments" }],
      });
      expect(document.errors[0].message).toMatch(/^Unknown command publish\./);
      expect(seen).toHaveLength(0);
    });

    it("refuses to send the credentials to another host", async () => {
      const result = await run(["check", "--url", "https://example.org"], {
        env: credentials,
        fetch: localFetch,
        log: () => {},
      });
      outputs.push(JSON.stringify(result.document));
      expect(result.exitCode).toBe(1);
      expect(result.document.errors[0].code).toBe("invalid-arguments");
      expect(seen).toHaveLength(0);
    });
  });
});
