// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_NOT_FOUND,
  checkCredentials,
  credentialCommand,
  credentialsFromEnvironment,
  parseCredentialOutput,
  runProcess,
} from "./credentials.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};

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

describe("runProcess", () => {
  describe("when the program runs", () => {
    it("returns its stdout and passes the extra environment", async () => {
      expect(
        await runProcess({
          file: process.execPath,
          args: ["-e", "process.stdout.write(process.env.PUBLISH_POST_TEST)"],
          env: { PUBLISH_POST_TEST: "from the environment" },
        }),
      ).toEqual({ code: 0, stdout: "from the environment" });
    });

    it("returns its exit code and none of its stderr", async () => {
      expect(
        await runProcess({
          file: process.execPath,
          args: ["-e", "console.error('noise'); process.exit(3)"],
          env: {},
        }),
      ).toEqual({ code: 3, stdout: "" });
    });
  });

  describe("when the program cannot be started", () => {
    it("returns a failure instead of throwing", async () => {
      expect(
        await runProcess({
          file: path.join(os.tmpdir(), "no-such-program-of-publish-post"),
          args: [],
          env: {},
        }),
      ).toEqual({ code: -1, stdout: "" });
    });
  });
});
