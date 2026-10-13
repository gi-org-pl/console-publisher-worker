import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readServiceToken, redact, runProcess } from "./queue-post/token.mjs";

// Queues one post on the channels a job names, through the Worker, as a
// service identity. Usage, the job and the output are in the README
// ("Queueing a post from the command line"). The script keeps no state: the
// request ID of a channel follows from the name of the post, so the Worker
// recognises a second run. The Worker validates every request; this script
// only keeps the token secret, keeps the image inside the job's folder and
// reports what the Worker answered.

const CONSOLE = "https://console.gi.org.pl";
const USAGE =
  "Usage: node scripts/queuePost.mjs check | preview <job.json> | queue <job.json> [--credential <name>]";

// Malformed bytes are an error, not a silent U+FFFD in a published text.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const jobSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  text: z.string(),
  image: z.string(),
  channels: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
});

/** @param {string[]} argv */
function parseArguments(argv) {
  const rest = [...argv];
  const at = rest.indexOf("--credential");
  const credential = at < 0 ? undefined : rest.splice(at, 2)[1];
  const [command, file, ...extra] = rest;
  const takesJob = command === "preview" || command === "queue";
  const isValid =
    (command === "check" || takesJob) &&
    takesJob === (file !== undefined) &&
    extra.length === 0 &&
    (at < 0 || credential !== undefined) &&
    ![file, credential].some((value) => value?.startsWith("--"));
  if (!isValid) throw new Error(USAGE);
  return { command, file, credential };
}

/** The image is read from inside the job's folder and nowhere else. */
async function readImage(folder, file) {
  const refuse = (why) => new Error(`The image "${file}" ${why}.`);
  if (path.isAbsolute(file))
    throw refuse("has to be a path inside the folder of the job");
  const real = await realpath(path.resolve(folder, file)).catch(() => {
    throw refuse("cannot be read");
  });
  const inside = path.relative(folder, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw refuse("is not inside the folder of the job");
  return readFile(real).catch(() => {
    throw refuse("cannot be read");
  });
}

/** The job file and its image. Nothing leaves the machine here. */
async function readJob(file, cwd) {
  const jobPath = path.resolve(cwd, file);
  let parsed;
  try {
    parsed = jobSchema.safeParse(
      JSON.parse(UTF8.decode(await readFile(jobPath))),
    );
  } catch (cause) {
    // What the file holds is not repeated: it may be any file.
    throw new Error(
      `Cannot read the job: ${cause?.code ?? "it is not JSON in UTF-8"}.`,
    );
  }
  if (!parsed.success)
    throw new Error(
      `The job is not valid: name, text, image and channels, and nothing else, are expected (see: ${parsed.error.issues.map((issue) => issue.path.join(".") || "job").join(", ")}).`,
    );
  const folder = path.dirname(await realpath(jobPath));
  return { ...parsed.data, bytes: await readImage(folder, parsed.data.image) };
}

/** The request ID of a channel: the same for every run of the same post. */
function requestId(clientId, name, channelId) {
  const hash = createHash("sha256")
    .update(`${clientId}\n${name}\n${channelId}`)
    .digest("hex");
  const variant = "89ab"[Number.parseInt(hash[16], 16) & 3];
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * One request to the Worker: its status and what it said, as JSON when it is
 * JSON. A service sends no `Origin` and follows no redirect.
 */
async function ask(
  { deps, token },
  route,
  { method = "GET", type, body } = {},
) {
  try {
    const response = await deps.fetch(new URL(route, deps.baseUrl), {
      method,
      headers: {
        "CF-Access-Client-Id": token.clientId,
        "CF-Access-Client-Secret": token.clientSecret,
        ...(type && { "Content-Type": type }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, response: parseJson(text) };
  } catch (cause) {
    return {
      status: 0,
      response: `No answer from the Console: ${cause instanceof Error ? cause.message : String(cause)}.`,
    };
  }
}

/** The four steps of `queue`: the token, the job, the image once, a post per channel. */
async function execute(argv, deps, secrets) {
  const { command, file, credential } = parseArguments(argv);
  const token = await readServiceToken(deps, credential);
  secrets.push(token.clientSecret, token.clientId);
  const context = { deps, token };
  if (command === "check")
    return {
      command,
      results: [
        { step: "session", ...(await ask(context, "/api/buffer/session")) },
      ],
    };

  const job = await readJob(file, deps.cwd);
  // These go out as they are: one that holds the token would publish it.
  const sent = [job.text, ...job.channels];
  if (sent.some((value) => secrets.some((secret) => value.includes(secret))))
    throw new Error(
      "The text or a channel of the job contains the service token. Nothing was sent.",
    );
  const channels = job.channels.map((channelId) => ({
    channelId,
    requestId: requestId(token.clientId, job.name, channelId),
  }));
  if (command === "preview")
    return {
      command,
      name: job.name,
      text: job.text,
      image: job.image,
      channels,
    };

  const upload = await ask(context, "/api/buffer/media", {
    method: "POST",
    type: "image/png",
    body: job.bytes,
  });
  const mediaId = upload.status === 200 ? upload.response?.mediaId : undefined;
  const results = [];
  for (const channel of channels)
    results.push(
      mediaId === undefined
        ? { ...channel, step: "upload", ...upload }
        : {
            ...channel,
            step: "post",
            ...(await ask(context, "/api/buffer/posts", {
              method: "POST",
              type: "application/json",
              body: JSON.stringify({
                requestId: channel.requestId,
                mediaId,
                channelId: channel.channelId,
                text: job.text,
                mode: "addToQueue",
              }),
            })),
          },
    );
  return { command, name: job.name, results };
}

/**
 * The whole command. Returns the exit code and the one JSON document that
 * belongs on stdout; everything it reads from outside can be replaced.
 * @param {string[]} argv
 * @param {object} [overrides] replacements for the defaults below, for tests
 */
export async function run(argv, overrides = {}) {
  const deps = {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    runProcess,
    baseUrl: CONSOLE,
    timeoutMs: 60_000,
    ...overrides,
  };
  const secrets = [];
  let document;
  try {
    document = await execute(argv, deps, secrets);
  } catch (cause) {
    // Whatever went wrong, the caller still gets the JSON document it parses.
    document = {
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  // Only a post the Worker accepted counts; a failed upload leaves no post.
  const ok =
    document.error === undefined &&
    (document.results ?? []).every(
      ({ step, status }) => step !== "upload" && status >= 200 && status < 300,
    );
  return {
    exitCode: ok ? 0 : 1,
    document: redact({ ok, command: null, ...document }, secrets),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { exitCode, document } = await run(process.argv.slice(2));
  // Stdout carries only the JSON result, so callers can parse it as is.
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exitCode = exitCode;
}
