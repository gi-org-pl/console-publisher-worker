// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLog, redact, redactDeep } from "./redaction.mjs";

const credentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret:
    "5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ecret5ec",
};

describe("redact and redactDeep", () => {
  const secrets = [credentials.clientSecret, credentials.clientId];

  describe("when a text carries a credential", () => {
    it("replaces every occurrence", () => {
      expect(
        redact(
          `id ${credentials.clientId}, secret ${credentials.clientSecret}${credentials.clientSecret}`,
          secrets,
        ),
      ).toBe("id [redacted], secret [redacted][redacted]");
    });

    it("leaves other text alone and ignores an empty secret", () => {
      expect(redact("nothing to hide", ["", ...secrets])).toBe(
        "nothing to hide",
      );
    });
  });

  describe("when a document carries one anywhere", () => {
    it("cleans values and keys and keeps the rest", () => {
      expect(
        redactDeep(
          {
            ok: false,
            count: 2,
            nothing: null,
            errors: [{ message: `bad ${credentials.clientSecret}` }],
            [credentials.clientSecret]: { step: "posting" },
          },
          secrets,
        ),
      ).toEqual({
        ok: false,
        count: 2,
        nothing: null,
        errors: [{ message: "bad [redacted]" }],
        "[redacted]": { step: "posting" },
      });
    });
  });
});

describe("createLog", () => {
  describe("when a line carries a credential", () => {
    it("writes the line without it", () => {
      const lines: string[] = [];
      const log = createLog(
        (line) => lines.push(line),
        [credentials.clientSecret, credentials.clientId],
      );
      log(`linkedin (${credentials.clientId}): post 200`);
      expect(lines).toEqual(["linkedin ([redacted]): post 200"]);
    });

    it("clears a secret that became known after the logger was made", () => {
      const lines: string[] = [];
      const secrets: string[] = [];
      const log = createLog((line) => lines.push(line), secrets);
      secrets.push(credentials.clientSecret);
      log(`answer: ${credentials.clientSecret}`);
      expect(lines).toEqual(["answer: [redacted]"]);
    });
  });

  describe("when the line cannot be written", () => {
    it("does not throw", () => {
      const log = createLog(() => {
        throw new Error("EPIPE");
      }, []);
      expect(() => log("session: 200")).not.toThrow();
    });
  });
});
