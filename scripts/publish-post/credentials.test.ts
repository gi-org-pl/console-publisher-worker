// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkCredentials,
  credentialsFromEnvironment,
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
