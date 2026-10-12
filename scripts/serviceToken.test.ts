// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readServiceToken,
  runProcess,
  windowsCommand,
} from "./serviceToken.mjs";

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

/** What `readCredential.ps1` prints for a stored credential. */
const stored = (value: unknown) => ({
  code: 0,
  stdout: `${Buffer.from(JSON.stringify(value)).toString("base64")}\r\n`,
});

/** A stand-in for `security`: the attributes first, the password when asked with -w. */
const security = (account: string, password: string) =>
  vi.fn(async ({ args }: { args: string[] }) => ({
    code: 0,
    stdout: args.includes("-w")
      ? `${password}\n`
      : `attributes:\n    0x00000007 <blob>="console-bot"\n    "acct"<blob>=${account}\n    "svce"<blob>="console-bot"\n`,
  }));

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

describe("the Windows credential store", () => {
  describe("when a credential is named", () => {
    it("starts PowerShell by its full path with nothing but what it needs", () => {
      const command = windowsCommand("console'; Remove-Item x", {
        SystemRoot: "D:\\Win",
        TEMP: "D:\\Tmp",
        CF_ACCESS_CLIENT_SECRET: "left behind",
        PATH: "C:\\elsewhere",
      });
      expect(command.file).toBe(
        "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(command.args.slice(0, 3)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      expect(command.env).toEqual({
        SystemRoot: "D:\\Win",
        TEMP: "D:\\Tmp",
        PUBLISH_POST_CREDENTIAL: "console'; Remove-Item x",
      });

      const script = Buffer.from(command.args[3], "base64").toString("utf16le");
      expect(script).not.toContain("Remove-Item");
      expect(script).toContain("CredRead($env:PUBLISH_POST_CREDENTIAL, 1, 0,");
      expect(script).toContain("{ exit 3 }");
      // A here-string ends only at the start of a line.
      expect(script).toMatch(/\n'@\n/);
      expect(script).not.toContain("\r");
    });

    it("falls back to the usual folders when the environment names none", () => {
      const command = windowsCommand("console-bot", {});
      expect(command.file).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(command.env.TEMP).toBe("C:\\Windows\\Temp");
    });

    it("returns the user name as Client ID and the password as Client Secret", async () => {
      const run = vi.fn(async () => stored(token));
      expect(
        await readServiceToken(
          { env: {}, platform: "win32", runProcess: run },
          "console-bot",
        ),
      ).toEqual(token);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(windowsCommand("console-bot", {}));
    });
  });

  describe("when the store does not give a usable credential", () => {
    it.each([
      [
        { code: 3, stdout: "" },
        "credential-unavailable",
        'The Windows credential store has no generic credential named "console-bot".',
      ],
      [
        { code: 1, stdout: "" },
        "credential-unavailable",
        "Reading the Windows credential store failed (PowerShell exit code 1).",
      ],
      [
        { code: 0, stdout: token.clientSecret },
        "credential-unavailable",
        "The answer of the credential store could not be read.",
      ],
      [
        stored({ clientId: token.clientId }),
        "credential-unavailable",
        "The answer of the credential store could not be read.",
      ],
      [
        stored(null),
        "credential-unavailable",
        "The answer of the credential store could not be read.",
      ],
      [
        stored({ clientId: "someone", clientSecret: token.clientSecret }),
        "invalid-credentials",
        'The Client ID from the credential "console-bot" is not a service token Client ID (32 hexadecimal characters and ".access").',
      ],
    ])("reports a reader that answers %j", async (result, code, message) => {
      await expect(
        readServiceToken(
          { env: {}, platform: "win32", runProcess: async () => result },
          "console-bot",
        ),
      ).rejects.toThrow(expect.objectContaining({ code, message }));
    });
  });
});

describe("the macOS Keychain", () => {
  describe("when the item exists", () => {
    it("reads the account first and then the password of that account", async () => {
      const run = security(`"${token.clientId}"`, token.clientSecret);
      expect(
        await readServiceToken(
          { env: {}, platform: "darwin", runProcess: run },
          "console-bot",
        ),
      ).toEqual(token);
      expect(run.mock.calls.map(([command]) => command)).toEqual([
        {
          file: "/usr/bin/security",
          args: ["find-generic-password", "-s", "console-bot"],
          env: {},
        },
        {
          file: "/usr/bin/security",
          args: [
            "find-generic-password",
            "-s",
            "console-bot",
            "-a",
            token.clientId,
            "-w",
          ],
          env: {},
        },
      ]);
    });
  });

  describe("when the item is not a service token", () => {
    it.each([
      ["no account", "<NULL>"],
      ["an account printed in hexadecimal", '0xC5BC  "\\305\\274"'],
      ["an account that is not a Client ID", '"someone@example.org"'],
    ])("refuses an item with %s before reading its password", async (_name, account) => {
      const run = security(account, "a password");
      const read = readServiceToken(
        { env: {}, platform: "darwin", runProcess: run },
        "Wi-Fi",
      );
      await expect(read).rejects.toThrow(
        expect.objectContaining({
          code: "credential-unavailable",
          message:
            'The account of the Keychain item "Wi-Fi" is not a service token Client ID. Its password was not read.',
        }),
      );
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the read fails", () => {
    it.each([
      [
        44,
        'The macOS Keychain has no generic password with the service name "console-bot".',
      ],
      [51, "Reading the macOS Keychain failed (security exit code 51)."],
      [-1, "Reading the macOS Keychain failed (security exit code -1)."],
    ])("reports exit code %i", async (code, message) => {
      await expect(
        readServiceToken(
          {
            env: {},
            platform: "darwin",
            runProcess: async () => ({ code, stdout: "" }),
          },
          "console-bot",
        ),
      ).rejects.toThrow(
        expect.objectContaining({ code: "credential-unavailable", message }),
      );
    });

    it("reports a password that could not be read, without the account", async () => {
      const run = vi.fn(async ({ args }: { args: string[] }) =>
        args.includes("-w")
          ? { code: 36, stdout: "" }
          : { code: 0, stdout: `    "acct"<blob>="${token.clientId}"\n` },
      );
      const read = readServiceToken(
        { env: {}, platform: "darwin", runProcess: run },
        "console-bot",
      );
      await expect(read).rejects.toThrow(
        "Reading the macOS Keychain failed (security exit code 36).",
      );
      await expect(read).rejects.not.toThrow(token.clientId);
    });
  });
});

describe("runProcess", () => {
  describe("when the program runs", () => {
    it("returns its stdout and gives it only the environment it was given", async () => {
      process.env.QUEUE_POST_PARENT_ONLY = "from the parent";
      try {
        expect(
          await runProcess({
            file: process.execPath,
            args: [
              "-e",
              "process.stdout.write(process.env.GIVEN + '|' + process.env.QUEUE_POST_PARENT_ONLY)",
            ],
            env: {
              GIVEN: "from the command",
              SystemRoot: process.env.SystemRoot ?? "",
            },
          }),
        ).toEqual({ code: 0, stdout: "from the command|undefined" });
      } finally {
        delete process.env.QUEUE_POST_PARENT_ONLY;
      }
    });

    it("returns its exit code and none of its stderr", async () => {
      expect(
        await runProcess({
          file: process.execPath,
          args: ["-e", "console.error('noise'); process.exit(3)"],
          env: { SystemRoot: process.env.SystemRoot ?? "" },
        }),
      ).toEqual({ code: 3, stdout: "" });
    });
  });

  describe("when the program cannot be started", () => {
    it("returns a failure instead of throwing", async () => {
      expect(
        await runProcess({
          file: path.join(os.tmpdir(), "no-such-program-of-queue-post"),
          args: [],
          env: {},
        }),
      ).toEqual({ code: -1, stdout: "" });
    });
  });
});
