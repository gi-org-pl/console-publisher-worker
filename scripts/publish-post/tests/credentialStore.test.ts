// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  client,
  clientId,
  clientSecret,
  count,
  seen,
  useWorkerStandIn,
} from "./workerStandIn";

useWorkerStandIn();

describe("the Windows credential store", () => {
  const stored = (value: unknown) => ({
    code: 0,
    stdout: Buffer.from(JSON.stringify(value)).toString("base64"),
  });

  describe("when the environment has no credentials", () => {
    it("asks the reader for the named credential and uses it", async () => {
      const reader = vi.fn(async () =>
        stored({ clientId, clientSecret: clientSecret }),
      );
      const { exitCode, document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(0);
      expect(document.identity).toEqual({ service: "gieniek-bot" });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(
        expect.objectContaining({
          file: "powershell",
          env: { PUBLISH_POST_CREDENTIAL: "console-bot" },
        }),
      );
    });

    it.each([
      [
        { code: 3, stdout: "" },
        'The Windows credential store has no generic credential named "console-bot".',
      ],
      [
        { code: 1, stdout: "" },
        "Reading the Windows credential store failed (PowerShell exit code 1).",
      ],
      [
        { code: 0, stdout: clientSecret },
        "The answer of the credential store could not be read.",
      ],
    ])("reports a reader that answers %j", async (result, message) => {
      const { exitCode, document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: async () => result },
      );
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "credential-unavailable", message },
      ]);
      expect(seen).toHaveLength(0);
    });

    it("refuses a credential that is not a service token", async () => {
      const { document } = await client(
        ["check", "--credential", "console-bot"],
        {
          env: {},
          platform: "win32",
          runProcess: async () =>
            stored({ clientId: "someone", clientSecret: clientSecret }),
        },
      );
      expect(document.errors).toEqual([
        {
          code: "invalid-credentials",
          message:
            'The Client ID from the credential "console-bot" is not a service token Client ID (32 hexadecimal characters and ".access").',
        },
      ]);
      expect(seen).toHaveLength(0);
    });

    it("says that the store exists on Windows only", async () => {
      const { document } = await client(
        ["check", "--credential", "console-bot"],
        { env: {} },
      );
      expect(document.errors).toEqual([
        {
          code: "credential-unavailable",
          message:
            "--credential reads the Windows credential store. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
        },
      ]);
    });
  });

  describe("when an error about the job names the stored Client ID", () => {
    it("is removed from the report", async () => {
      const reader = vi.fn(async () =>
        stored({ clientId, clientSecret: clientSecret }),
      );
      const { exitCode, document, logs } = await client(
        ["queue", `${clientId}.json`, "--credential", "console-bot"],
        { env: {}, platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(1);
      expect(reader).toHaveBeenCalledTimes(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(JSON.stringify(document)).not.toContain(clientId);
      expect(logs.join("\n")).not.toContain(clientId);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
    });
  });

  describe("when the environment has both variables", () => {
    it("does not read the store", async () => {
      const reader = vi.fn();
      const { exitCode } = await client(
        ["check", "--credential", "console-bot"],
        { platform: "win32", runProcess: reader },
      );
      expect(exitCode).toBe(0);
      expect(reader).not.toHaveBeenCalled();
    });
  });
});
