// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_NOT_FOUND,
  credentialCommand,
  parseCredentialOutput,
} from "./windowsCredential.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};

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
