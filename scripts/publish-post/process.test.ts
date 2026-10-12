// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "./process.mjs";

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
