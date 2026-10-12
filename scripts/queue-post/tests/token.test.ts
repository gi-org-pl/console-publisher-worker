// @vitest-environment node
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  clientId,
  clientSecret,
  script,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("the token", () => {
  describe("when the other side repeats it", () => {
    it("is removed from the session error and from a channel's message", async () => {
      standIn.answer = () =>
        Response.json(
          { message: `No access for ${clientId} with ${clientSecret}` },
          { status: 403 },
        );
      const refused = await script(["check"]);
      expect(refused.document.errors[0].message).toBe(
        "No access for [redacted] with [redacted]",
      );

      const job = await writeJob({ channels: ["li1"] });
      standIn.answer = (request) =>
        request.path === "/api/buffer/posts"
          ? Response.json(
              { message: `${"x".repeat(470)}${clientSecret}` },
              { status: 400 },
            )
          : undefined;
      const { document } = await script(["queue", job]);
      expect(document.channels[0].outcome).toBe("refused");
      expect(document.channels[0].message).toBe(`${"x".repeat(470)}[redacted]`);
    });
  });

  describe("when it is missing", () => {
    it("fails with a clear message and sends nothing", async () => {
      const { exitCode, document } = await script(["check"], { env: {} });
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("missing-credentials");
      expect(seen).toHaveLength(0);
    });
  });

  describe("when it comes from the credential store", () => {
    it("is read once and removed from an error about the job", async () => {
      const reader = vi.fn(async () => ({
        code: 0,
        stdout: Buffer.from(
          JSON.stringify({ clientId, clientSecret }),
        ).toString("base64"),
      }));
      const { document } = await script(
        ["queue", `${clientId}.json`, "--credential", "console-bot"],
        {
          env: {},
          platform: "win32",
          runProcess: reader,
        },
      );
      expect(reader).toHaveBeenCalledTimes(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(seen).toHaveLength(0);
    });
  });

  describe("when something unforeseen throws with it", () => {
    it.each([
      [new Error(`EIO near ${clientSecret}`), "EIO near [redacted]"],
      [`a plain value with ${clientId}`, "a plain value with [redacted]"],
    ])("still returns the document, without the token", async (thrown, message) => {
      const job = await writeJob();
      const { exitCode, document } = await script(["preview", job], {
        fs: {
          readFile,
          stat,
          realpath: async () => {
            throw thrown;
          },
        },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([{ code: "unexpected", message }]);
      expect(seen).toHaveLength(0);
    });
  });
});
