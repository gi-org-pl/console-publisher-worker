// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  bufferFetch,
  clientSecret,
  credentials,
  instagram,
  linkedin,
  origin,
  outcomes,
  seen,
  spawnClient,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("the command in its own process", () => {
  describe("when it checks the session", () => {
    it("prints one JSON document on stdout and the diagnostics on stderr", async () => {
      const { exitCode, stdout, stderr } = await spawnClient(
        ["check"],
        credentials,
      );
      expect(exitCode).toBe(0);
      const document = JSON.parse(stdout);
      expect(stdout).toBe(`${JSON.stringify(document, null, 2)}\n`);
      expect(document).toEqual({
        ok: true,
        command: "check",
        sent: false,
        url: origin,
        identity: { service: "gieniek-bot" },
        channels: [linkedin, instagram],
        errors: [],
      });
      expect(stderr).toBe("session: 200\n");
    });
  });

  describe("when it queues a job twice", () => {
    it("creates the posts once", async () => {
      const job = await writeJob();
      const first = await spawnClient(["queue", job, "--send"], credentials);
      expect(first.exitCode).toBe(0);
      expect(outcomes(JSON.parse(first.stdout).channels)).toEqual({
        li1: "created",
        ig1: "created",
      });

      const second = await spawnClient(["queue", job, "--send"], credentials);
      expect(second.exitCode).toBe(0);
      expect(outcomes(JSON.parse(second.stdout).channels)).toEqual({
        li1: "already-created",
        ig1: "already-created",
      });
      expect(bufferFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("when it fails", () => {
    it("exits with 1 and still prints the document, without the secret", async () => {
      const missing = await spawnClient(["check"], {});
      expect(missing.exitCode).toBe(1);
      expect(JSON.parse(missing.stdout).errors[0].code).toBe(
        "missing-credentials",
      );
      expect(missing.stderr).toBe("");

      const refused = await spawnClient(["check"], {
        ...credentials,
        CF_ACCESS_CLIENT_SECRET: `${clientSecret}0`,
      });
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout).errors).toEqual([
        {
          code: "session-failed",
          status: 401,
          message: "Sign in via Cloudflare Access.",
        },
      ]);
      expect(refused.stdout + refused.stderr).not.toContain(clientSecret);
      expect(seen).toHaveLength(1);
    });
  });
});
