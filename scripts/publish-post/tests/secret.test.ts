// @vitest-environment node
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../run.mjs";
import {
  client,
  clientId,
  clientSecret,
  count,
  credentials,
  dir,
  instagram,
  localFetch,
  origin,
  outputs,
  readState,
  seen,
  standIn,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("the secret", () => {
  describe("when a text of the job holds a credential of the service", () => {
    it.each([
      [
        "the Client Secret in the text",
        { text: `Our key is ${clientSecret}, enjoy` },
        "text contains the Client Secret of this service",
      ],
      [
        "the Client ID in a text file",
        { text: undefined, textFile: "post.txt" },
        "text contains the Client ID of this service",
      ],
      [
        "both in the text for one channel",
        { channelText: { linkedin: `${clientId} ${clientSecret}` } },
        "the text for linkedin contains the Client Secret of this service; the text for linkedin contains the Client ID of this service",
      ],
    ])("stops at %s before any request", async (_name, change, found) => {
      const job = await writeJob(change);
      await writeFile(path.join(dir, "post.txt"), `Reach us as ${clientId}`);

      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const { exitCode, document } = await client(argv);
        expect(exitCode).toBe(1);
        expect(document.errors).toEqual([
          {
            code: "invalid-job",
            message: `${found}. Nothing was sent: take it out of the text, and replace the credential if the text was shown to anyone.`,
          },
        ]);
        expect(document.channels).toEqual([]);
      }
      expect(seen).toHaveLength(0);
      expect(await readdir(dir)).not.toContain("post.state.json");
      // The files of this test hold the values on purpose; the check after
      // each test is about what the client wrote.
      await rm(path.join(dir, job));
      await rm(path.join(dir, "post.txt"));
    });
  });

  const leaking = (failAt: string): typeof fetch => {
    return async (input, init) => {
      if ((input as URL).pathname === failAt)
        throw new TypeError(`Invalid header value ${clientSecret}`, {
          cause: new Error(`CF-Access-Client-Secret: ${clientSecret}`),
        });
      return localFetch(input, init);
    };
  };

  describe("when an error before the credentials are loaded names the Client ID", () => {
    it("is removed from the report all the same", async () => {
      const { exitCode, document, logs } = await client([
        "queue",
        `${clientId}.json`,
      ]);
      expect(exitCode).toBe(1);
      expect(document.errors[0].code).toBe("invalid-job");
      expect(document.errors[0].message).toMatch(/^Cannot read the job /);
      expect(JSON.stringify(document)).not.toContain(clientId);
      expect(logs.join("\n")).not.toContain(clientId);
      expect(count()).toEqual({ session: 0, media: 0, posts: 0 });
    });
  });

  describe("when a failed request names it", () => {
    it.each([
      ["/api/buffer/session"],
      ["/api/buffer/media"],
      ["/api/buffer/posts"],
    ])("is removed from the report of a failure at %s", async (failAt) => {
      const job = await writeJob({ channels: ["linkedin"] });
      const { exitCode, document } = await client(["queue", job, "--send"], {
        fetch: leaking(failAt),
      });
      expect(exitCode).toBe(1);
      const report = JSON.stringify(document);
      expect(report).toContain(
        "Invalid header value [redacted] (CF-Access-Client-Secret: [redacted])",
      );
      expect(report).not.toContain(clientSecret);
      if (failAt !== "/api/buffer/session")
        expect(JSON.stringify(await readState())).toContain("[redacted]");
    });
  });

  describe("when the other side repeats it", () => {
    it.each([
      ["/api/buffer/session", 403],
      ["/api/buffer/media", 400],
      ["/api/buffer/posts", 403],
      ["/api/buffer/posts", 500],
    ])("is removed from the message of %s answering %i", async (failAt, status) => {
      const job = await writeJob({ channels: ["linkedin"] });
      standIn.answer = (request) =>
        request.path === failAt
          ? Response.json(
              {
                message: `Bad token ${request.headers["cf-access-client-secret"]} for ${request.headers["cf-access-client-id"]}`,
              },
              { status },
            )
          : undefined;
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      expect(JSON.stringify(document)).toContain(
        "Bad token [redacted] for [redacted]",
      );
    });

    it.each([
      ["/api/buffer/media", 400],
      ["/api/buffer/posts", 403],
    ])("is removed whole when it lies across the length limit of a message of %s", async (failAt, status) => {
      const job = await writeJob({ channels: ["linkedin"] });
      // A message is cut at 500 characters: the secret starts ten before.
      const padding = "p".repeat(490);
      standIn.answer = (request) =>
        request.path === failAt
          ? Response.json(
              {
                message: `${padding}${request.headers["cf-access-client-secret"]} and ${request.headers["cf-access-client-id"]}`,
              },
              { status },
            )
          : undefined;
      const { exitCode, document } = await client(["queue", job, "--send"]);
      expect(exitCode).toBe(1);
      const report = JSON.stringify(document);
      const state = JSON.stringify(await readState());
      for (const text of [report, state]) {
        expect(text).toContain(`${padding}[redacted]`);
        expect(text).not.toContain(clientSecret.slice(0, 8));
        expect(text).not.toContain(clientId.slice(0, 8));
      }
    });

    it.each([
      ["cf-access-client-secret"],
      ["cf-access-client-id"],
    ])("refuses a session whose channel ID carries %s, and writes no state", async (header) => {
      const job = await writeJob();
      standIn.answer = (request) =>
        request.path === "/api/buffer/session"
          ? Response.json({
              service: "gieniek-bot",
              channels: [
                {
                  id: `ch-${request.headers[header]}`,
                  name: "Echo",
                  service: "linkedin",
                },
                instagram,
              ],
            })
          : undefined;

      for (const argv of [
        ["queue", job, "--send"],
        ["queue", job],
      ]) {
        const { exitCode, document } = await client(argv);
        expect(exitCode).toBe(1);
        expect(document.errors).toEqual([
          {
            code: "unusable-channel",
            message:
              "The session lists a channel whose ID contains a credential of this service: linkedin (ch-[redacted]). Nothing is sent until the Worker's channel list is fixed.",
          },
        ]);
        expect(document.channels).toEqual([]);
      }
      expect(count()).toEqual({ session: 2, media: 0, posts: 0 });
      expect(await readdir(dir)).not.toContain("post.state.json");
    });
  });

  describe("when something unforeseen throws with it", () => {
    it("is removed from the unexpected error and no stack is printed", async () => {
      const job = await writeJob();
      const { exitCode, document, logs } = await client(["queue", job], {
        newId: () => {
          throw new Error(`broken near ${clientSecret}`);
        },
      });
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "unexpected", message: "broken near [redacted]" },
      ]);
      expect(logs).toEqual(["session: 200"]);
    });

    it("reports a thrown value that is not an error", async () => {
      const job = await writeJob();
      const { document } = await client(["queue", job], {
        newId: () => {
          throw `id source failed for ${clientSecret}`;
        },
      });
      expect(document.errors).toEqual([
        { code: "unexpected", message: "id source failed for [redacted]" },
      ]);
    });
  });

  describe("when stderr is closed", () => {
    it("still reports what happened to the post", async () => {
      const job = await writeJob({ channels: ["linkedin"] });
      const result = await run(["queue", job, "--send", "--url", origin], {
        env: credentials,
        fetch: localFetch,
        cwd: dir,
        log: () => {
          throw new Error("EPIPE");
        },
      });
      outputs.push(JSON.stringify(result.document));
      expect(result.exitCode).toBe(0);
      expect(result.document.channels[0].outcome).toBe("created");
    });
  });
});
