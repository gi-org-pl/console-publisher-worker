// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readServiceToken } from "./serviceToken.mjs";

const token = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};
const fromEnvironment = {
  CF_ACCESS_CLIENT_ID: token.clientId,
  CF_ACCESS_CLIENT_SECRET: token.clientSecret,
};
const never = async () => {
  throw new Error("The credential store must not be read here");
};

describe("the environment", () => {
  describe("when both variables are set", () => {
    it("is used, and the store is not read even when one is named", async () => {
      expect(
        await readServiceToken(
          { env: fromEnvironment, platform: "win32", runProcess: never },
          "console-bot",
        ),
      ).toEqual(token);
    });
  });

  describe("when the pair cannot be a service token", () => {
    it.each([
      [
        { CF_ACCESS_CLIENT_ID: "someone" },
        'The Client ID from the environment is not a service token Client ID (32 hexadecimal characters and ".access").',
      ],
      [
        { CF_ACCESS_CLIENT_SECRET: "e" },
        "The Client Secret from the environment is not a service token secret: it is shorter than 32 characters or holds spaces or characters a header cannot carry.",
      ],
      [
        { CF_ACCESS_CLIENT_SECRET: `${"a".repeat(40)} b` },
        "The Client Secret from the environment is not a service token secret: it is shorter than 32 characters or holds spaces or characters a header cannot carry.",
      ],
    ])("refuses %j without repeating a value", async (change, message) => {
      await expect(
        readServiceToken({
          env: { ...fromEnvironment, ...change },
          platform: "linux",
          runProcess: never,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: "invalid-credentials", message }),
      );
    });
  });

  describe("when a variable is missing and no store is named", () => {
    it.each([
      [{}],
      [{ CF_ACCESS_CLIENT_ID: token.clientId }],
      [{ CF_ACCESS_CLIENT_SECRET: token.clientSecret }],
    ])("reports %j as missing credentials", async (env) => {
      await expect(
        readServiceToken({ env, platform: "win32", runProcess: never }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "missing-credentials",
          message:
            "Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or pass --credential <name> on Windows or macOS.",
        }),
      );
    });
  });

  describe("when the system has no store this script reads", () => {
    it("says which systems have one", async () => {
      await expect(
        readServiceToken(
          { env: {}, platform: "linux", runProcess: never },
          "console-bot",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "credential-unavailable",
          message:
            "--credential reads the Windows credential store or the macOS Keychain. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
        }),
      );
    });
  });
});
