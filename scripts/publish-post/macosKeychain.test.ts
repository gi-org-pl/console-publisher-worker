// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainAccountCommand,
  keychainSecretCommand,
  parseKeychainAccount,
  readKeychain,
} from "./macosKeychain.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};

/** The attributes of an item as `security find-generic-password` prints them. */
function attributes(account: string) {
  return [
    'keychain: "/Users/someone/Library/Keychains/login.keychain-db"',
    "version: 512",
    'class: "genp"',
    "attributes:",
    '    0x00000007 <blob>="console-bot"',
    "    0x00000008 <blob>=<NULL>",
    `    "acct"<blob>=${account}`,
    '    "cdat"<timedate>=0x32303236313031323138353230305A00  "20261012185200Z\\000"',
    '    "crtr"<uint32>=<NULL>',
    '    "desc"<blob>=<NULL>',
    '    "svce"<blob>="console-bot"',
    "",
  ].join("\n");
}

/** A stand-in for `security`: the first call prints the attributes, the second the password. */
function security(account: string, password: string) {
  return vi.fn(async ({ args }: { args: string[] }) => ({
    code: 0,
    stdout: args.includes("-w") ? `${password}\n` : attributes(account),
  }));
}

describe("the commands", () => {
  describe("when an item is named", () => {
    it("asks the system's security for the attributes without the password", () => {
      expect(keychainAccountCommand("console-bot")).toEqual({
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", "console-bot"],
        env: {},
      });
    });

    it("asks for the password of the item with that account and nothing else", () => {
      expect(
        keychainSecretCommand("console-bot", credentials.clientId),
      ).toEqual({
        file: "/usr/bin/security",
        args: [
          "find-generic-password",
          "-s",
          "console-bot",
          "-a",
          credentials.clientId,
          "-w",
        ],
        env: {},
      });
    });

    it("passes a name with shell characters as one argument", () => {
      const name = 'x"; rm -rf ~ #';
      expect(keychainAccountCommand(name).args).toEqual([
        "find-generic-password",
        "-s",
        name,
      ]);
    });
  });
});

describe("parseKeychainAccount", () => {
  describe("when the attributes name an account", () => {
    it("returns it", () => {
      expect(
        parseKeychainAccount(attributes(`"${credentials.clientId}"`)),
      ).toBe(credentials.clientId);
    });
  });

  describe("when they do not", () => {
    it.each([
      ["no account", attributes("<NULL>")],
      ["an empty account", attributes('""')],
      ["an account printed in hexadecimal", attributes('0xC5BC  "\\305\\274"')],
      ["no attributes at all", ""],
    ])("returns nothing for %s", (_name, stdout) => {
      expect(parseKeychainAccount(stdout)).toBeUndefined();
    });
  });
});

describe("readKeychain", () => {
  describe("when the item exists", () => {
    it("returns the account as Client ID and the password as Client Secret", async () => {
      const runProcess = security(
        `"${credentials.clientId}"`,
        credentials.clientSecret,
      );
      expect(await readKeychain("console-bot", { runProcess })).toEqual(
        credentials,
      );
      expect(runProcess).toHaveBeenCalledTimes(2);
      expect(runProcess).toHaveBeenNthCalledWith(
        1,
        keychainAccountCommand("console-bot"),
      );
      expect(runProcess).toHaveBeenNthCalledWith(
        2,
        keychainSecretCommand("console-bot", credentials.clientId),
      );
    });

    it("keeps a password as it is, apart from the line break security adds", async () => {
      const runProcess = security(`"${credentials.clientId}"`, " padded ");
      expect(
        (await readKeychain("console-bot", { runProcess })).clientSecret,
      ).toBe(" padded ");
    });
  });

  describe("when the Keychain has no such item", () => {
    it("says so and reads nothing else", async () => {
      const runProcess = vi.fn(async () => ({
        code: KEYCHAIN_ITEM_NOT_FOUND,
        stdout: "",
      }));
      await expect(readKeychain("console-bot", { runProcess })).rejects.toThrow(
        expect.objectContaining({
          code: "credential-unavailable",
          message:
            'The macOS Keychain has no generic password with the service name "console-bot".',
        }),
      );
      expect(runProcess).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the read fails", () => {
    it.each([
      [51, "the attributes"],
      [-1, "the attributes"],
    ])("reports exit code %i for %s", async (code) => {
      const runProcess = vi.fn(async () => ({ code, stdout: "" }));
      await expect(readKeychain("console-bot", { runProcess })).rejects.toThrow(
        expect.objectContaining({
          code: "credential-unavailable",
          message: `Reading the macOS Keychain failed (security exit code ${code}).`,
        }),
      );
    });

    it("reports a password that could not be read, without the account", async () => {
      const runProcess = vi.fn(async ({ args }: { args: string[] }) =>
        args.includes("-w")
          ? { code: 36, stdout: "" }
          : { code: 0, stdout: attributes(`"${credentials.clientId}"`) },
      );
      const read = readKeychain("console-bot", { runProcess });
      await expect(read).rejects.toThrow(
        "Reading the macOS Keychain failed (security exit code 36).",
      );
      await expect(read).rejects.not.toThrow(credentials.clientId);
    });
  });

  describe("when the item is not a service token", () => {
    it("refuses an item without an account before reading its password", async () => {
      const runProcess = security("<NULL>", credentials.clientSecret);
      await expect(readKeychain("console-bot", { runProcess })).rejects.toThrow(
        expect.objectContaining({
          code: "credential-unavailable",
          message:
            'The Keychain item "console-bot" has no account that can be read. Its account has to be the Client ID.',
        }),
      );
      expect(runProcess).toHaveBeenCalledTimes(1);
    });

    it("refuses an account that is not a Client ID before reading its password", async () => {
      const runProcess = security('"someone@example.org"', "a password");
      const read = readKeychain("Wi-Fi", { runProcess });
      await expect(read).rejects.toThrow(
        expect.objectContaining({
          code: "invalid-credentials",
          message:
            'The account of the Keychain item "Wi-Fi" is not a service token Client ID (32 hexadecimal characters and ".access"). Its password was not read.',
        }),
      );
      await expect(read).rejects.not.toThrow("someone@example.org");
      expect(runProcess).toHaveBeenCalledTimes(1);
    });
  });
});
