// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientSecret,
  count,
  dir,
  png,
  script,
  seen,
  useWorkerStandIn,
  writeJob,
} from "./workerStandIn";

useWorkerStandIn();

describe("the job", () => {
  describe("when it cannot be used", () => {
    it.each([
      ["a missing file", undefined, "Cannot read the job: ENOENT."],
      [
        "something that is not JSON",
        "API_KEY=sk-live-123",
        "Cannot read the job: it is not JSON in UTF-8.",
      ],
      [
        "an unknown key",
        JSON.stringify({
          name: "autumn-news",
          text: "Hello",
          image: "post.png",
          mode: "shareNow",
        }),
        "The job is not valid: job: has keys this script does not know.",
      ],
      [
        "a name that is not a slug",
        JSON.stringify({
          name: "Autumn News!",
          text: "Hello",
          image: "post.png",
        }),
        "The job is not valid: name: 3 to 64 lower-case letters, digits and hyphens.",
      ],
    ])("refuses %s before any request", async (_name, content, message) => {
      await writeFile(path.join(dir, "post.png"), png());
      if (content !== undefined)
        await writeFile(path.join(dir, "post.json"), content);
      const { exitCode, document } = await script(["queue", "post.json"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([{ code: "invalid-job", message }]);
      expect(seen).toHaveLength(0);
    });

    it.each([
      [
        "an empty text",
        { text: "   " },
        /^The post for linkedin \(li1\) would be refused: text: /,
      ],
      [
        "a text over the Worker's limit",
        { text: "a".repeat(5001) },
        /^The post for linkedin \(li1\) would be refused: text: /,
      ],
      [
        "a channel the session does not have",
        { channels: ["facebook"] },
        /^Not a channel of this session: facebook\. The session has: linkedin \(li1\), instagram \(ig1\)\.$/,
      ],
      [
        "an override for a channel the session does not have",
        { overrides: { x: { text: "Hi" } } },
        /^Not a channel of this session: x\./,
      ],
    ])("refuses %s after the session and sends nothing", async (_name, change, message) => {
      const job = await writeJob(change);
      const { document } = await script(["queue", job]);
      expect(document.errors).toEqual([
        { code: "invalid-job", message: expect.stringMatching(message) },
      ]);
      expect(count("media") + count("posts")).toBe(0);
    });

    it("refuses a text that holds the token, without repeating it", async () => {
      const job = await writeJob({
        overrides: { ig1: { text: `secret: ${clientSecret}` } },
      });
      const { document } = await script(["queue", job]);
      expect(document.errors).toEqual([
        {
          code: "invalid-job",
          message:
            "The text for instagram (ig1) contains the service token. Nothing was sent.",
        },
      ]);
      expect(count("media") + count("posts")).toBe(0);
    });
  });

  describe("when an image is not a PNG inside the folder of the job", () => {
    it.each([
      [
        "a file above the folder",
        "../outside.png",
        'The image "../outside.png" is not inside the folder of the job.',
      ],
      [
        "an absolute path",
        path.join(os.tmpdir(), "outside.png"),
        "has to be a path inside the folder of the job.",
      ],
      [
        "a network path",
        "//host/share/outside.png",
        "has to be a path inside the folder of the job.",
      ],
      [
        "a missing file",
        "post-missing.png",
        'The image "post-missing.png" cannot be read.',
      ],
      [
        "a file that is not a PNG",
        "post-text.png",
        'The image "post-text.png" is not a PNG.',
      ],
      [
        "a file over the limit",
        "post-huge.png",
        'The image "post-huge.png" is larger than 5 MB.',
      ],
      [
        "the folder itself",
        ".",
        'The image "." is not inside the folder of the job.',
      ],
    ])("refuses %s before any request", async (_name, image, message) => {
      await mkdir(path.join(dir, "inner"));
      await writeFile(path.join(dir, "outside.png"), png());
      await writeFile(
        path.join(dir, "inner", "post-text.png"),
        "not a picture",
      );
      await writeFile(
        path.join(dir, "inner", "post-huge.png"),
        png(5 * 1024 * 1024 + 1),
      );
      await writeFile(
        path.join(dir, "inner", "post.json"),
        JSON.stringify({ name: "autumn-news", text: "Hello", image }),
      );
      const { exitCode, document } = await script(["queue", "inner/post.json"]);
      expect(exitCode).toBe(1);
      expect(document.errors).toEqual([
        { code: "invalid-job", message: expect.stringContaining(message) },
      ]);
      expect(seen).toHaveLength(0);
    });
  });
});
