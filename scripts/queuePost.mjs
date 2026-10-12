import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  publishInputSchema,
  publishResultSchema,
  sessionSchema,
  uploadSchema,
} from "../src/schemas/publishing.ts";
import { readServiceToken, runProcess, ScriptError } from "./serviceToken.mjs";

// Queues one post per channel through the Worker as a service identity.
// Usage, the job and the output are in the README ("Queueing a post from the
// command line"). The script keeps no state: the request ID of a channel
// follows from the name of the post, so the Worker recognises a second run.

const CONSOLE = "https://console.gi.org.pl";
const USAGE =
  "Usage: node scripts/queuePost.mjs check | preview <job.json> | queue <job.json> [--credential <name>]";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const invalidJob = (message) => new ScriptError("invalid-job", message);

/** @param {string[]} argv */
function parseArguments(argv) {
  const rest = [...argv];
  const at = rest.indexOf("--credential");
  const credential = at < 0 ? undefined : rest.splice(at, 2)[1];
  const [command, job, ...extra] = rest;
  const takesJob = command === "preview" || command === "queue";
  const isValid =
    (command === "check" || takesJob) &&
    takesJob === (job !== undefined) &&
    extra.length === 0 &&
    (at < 0 || credential !== undefined) &&
    ![job, credential].some((value) => value?.startsWith("--"));
  if (!isValid) throw new ScriptError("invalid-arguments", USAGE);
  return { command, job, credential };
}

const variantSchema = z.strictObject({
  text: z.string().optional(),
  image: z.string().optional(),
});
const jobSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, {
    message: "3 to 64 lower-case letters, digits and hyphens",
  }),
  text: z.string(),
  image: z.string(),
  channels: z.array(z.string().min(1)).min(1).optional(),
  overrides: z.record(z.string().min(1), variantSchema).default({}),
});

/** A PNG of the job, read from inside the job's folder and nowhere else. */
async function readImage(folder, file, fs) {
  const refuse = (why) => invalidJob(`The image "${file}" ${why}.`);
  if (path.isAbsolute(file))
    throw refuse("has to be a path inside the folder of the job");
  let real;
  let size;
  try {
    real = await fs.realpath(path.resolve(folder, file));
    size = (await fs.stat(real)).size;
  } catch {
    throw refuse("cannot be read");
  }
  const inside = path.relative(folder, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw refuse("is not inside the folder of the job");
  if (size > MAX_IMAGE_BYTES) throw refuse("is larger than 5 MB");
  const bytes = await fs.readFile(real);
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte))
    throw refuse("is not a PNG");
  return bytes;
}

/** Reads the job and its images; nothing leaves the machine here. */
async function readJob(file, { cwd, fs }) {
  const jobPath = path.resolve(cwd, file);
  let parsed;
  try {
    parsed = jobSchema.safeParse(
      JSON.parse(UTF8.decode(await fs.readFile(jobPath))),
    );
  } catch (cause) {
    // What the file holds is not repeated: it may be any file.
    throw invalidJob(
      `Cannot read the job: ${cause?.code ?? "it is not JSON in UTF-8"}.`,
    );
  }
  if (!parsed.success)
    throw invalidJob(
      `The job is not valid: ${parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "job"}: ${issue.code === "unrecognized_keys" ? "has keys this script does not know" : issue.message}`,
        )
        .join("; ")}.`,
    );
  const job = parsed.data;
  const folder = path.dirname(await fs.realpath(jobPath));
  const files = new Set([
    job.image,
    ...Object.values(job.overrides).flatMap(({ image }) => image ?? []),
  ]);
  const images = new Map();
  for (const name of files) images.set(name, await readImage(folder, name, fs));
  return { job, images };
}

/** The request ID of a channel: the same for every run of the same post. */
function requestId(clientId, name, channelId) {
  const hash = createHash("sha256")
    .update(`${clientId}\n${name}\n${channelId}`)
    .digest("hex");
  const variant = "89ab"[Number.parseInt(hash[16], 16) & 3];
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** What each selected channel gets. Everything a request needs but the media ID is checked here. */
function plan(job, channels, token) {
  const matches = (key, channel) =>
    key === channel.id || key === channel.service;
  const strangers = [
    ...(job.channels ?? []),
    ...Object.keys(job.overrides),
  ].filter((key) => !channels.some((channel) => matches(key, channel)));
  if (strangers.length > 0)
    throw invalidJob(
      `Not a channel of this session: ${strangers.join(", ")}. The session has: ${channels
        .map((channel) => `${channel.service} (${channel.id})`)
        .join(", ")}.`,
    );
  return channels
    .filter(
      (channel) =>
        !job.channels || job.channels.some((key) => matches(key, channel)),
    )
    .map((channel) => {
      // An override for the channel itself comes before one for its network.
      const own = {
        ...job.overrides[channel.service],
        ...job.overrides[channel.id],
      };
      const entry = {
        channel,
        requestId: requestId(token.clientId, job.name, channel.id),
        text: own.text ?? job.text,
        image: own.image ?? job.image,
      };
      const probe = publishInputSchema.safeParse(body(entry, entry.requestId));
      if (!probe.success)
        throw invalidJob(
          `The post for ${channel.service} (${channel.id}) would be refused: ${probe.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}.`,
        );
      // A text goes out as it is: one that holds the token would publish it.
      if (
        [token.clientId, token.clientSecret].some((value) =>
          entry.text.includes(value),
        )
      )
        throw invalidJob(
          `The text for ${channel.service} (${channel.id}) contains the service token. Nothing was sent.`,
        );
      return entry;
    });
}

const body = ({ channel, requestId: id, text }, mediaId) => ({
  requestId: id,
  mediaId,
  channelId: channel.id,
  text,
  mode: "addToQueue",
});

/** Removes both values of the token from every string of a JSON value. */
function redact(value, secrets) {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets),
        redact(item, secrets),
      ]),
    );
  return value;
}

/** One request to the Console. A service sends no `Origin` and follows no redirect. */
async function ask(
  { deps, token, secrets },
  { method = "GET", route, type, payload },
) {
  let response;
  try {
    response = await deps.fetch(new URL(route, deps.baseUrl), {
      method,
      headers: {
        "CF-Access-Client-Id": token.clientId,
        "CF-Access-Client-Secret": token.clientSecret,
        ...(type ? { "Content-Type": type } : {}),
      },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (cause) {
    return {
      status: 0,
      message: `No answer from the Console: ${cause instanceof Error ? cause.message : String(cause)}.`,
    };
  }
  const data = await response.json().catch(() => undefined);
  const said =
    typeof data?.message === "string"
      ? data.message
      : `The Console answered ${response.status} without a message.`;
  // Cleared before it is cut, so no half of a secret survives the cut.
  return {
    status: response.status,
    data,
    message: redact(said, secrets).slice(0, 500),
  };
}

/** What happened to a post request, and what that means for running the job again. */
function outcomeOf(answer) {
  const created =
    answer.status === 200
      ? publishResultSchema.safeParse(answer.data)
      : undefined;
  if (created?.success)
    return { outcome: "created", postId: created.data.postId };
  const refused = answer.status >= 300 && answer.status < 500;
  const outcome =
    answer.status === 409 ? "already-sent" : refused ? "refused" : "unknown";
  const advice =
    outcome === "unknown"
      ? " The post may exist: check Buffer. Running the job again cannot create a second one."
      : "";
  return {
    outcome,
    ...(answer.status ? { status: answer.status } : {}),
    message: `${answer.message}${advice}`,
  };
}

/** Uploads the image of a channel, once per file and run, and posts. */
async function send(entry, images, uploads, context) {
  if (!uploads.has(entry.image))
    uploads.set(
      entry.image,
      await ask(context, {
        method: "POST",
        route: "/api/buffer/media",
        type: "image/png",
        payload: images.get(entry.image),
      }),
    );
  const upload = uploads.get(entry.image);
  const media =
    upload.status === 200 ? uploadSchema.safeParse(upload.data) : undefined;
  if (!media?.success)
    return {
      outcome: "failed",
      ...(upload.status ? { status: upload.status } : {}),
      message: `The image was not uploaded, so nothing was posted: ${upload.message}`,
    };
  return outcomeOf(
    await ask(context, {
      method: "POST",
      route: "/api/buffer/posts",
      type: "application/json",
      payload: JSON.stringify(body(entry, media.data.mediaId)),
    }),
  );
}

async function execute(argv, deps, document, secrets) {
  const { command, job: file, credential } = parseArguments(argv);
  document.command = command;
  const token = await readServiceToken(deps, credential);
  secrets.push(token.clientSecret, token.clientId);
  const context = { deps, token, secrets };
  const read = file === undefined ? undefined : await readJob(file, deps);

  const answer = await ask(context, { route: "/api/buffer/session" });
  const session =
    answer.status === 200 ? sessionSchema.safeParse(answer.data) : undefined;
  if (!session?.success)
    throw new ScriptError(
      "session-failed",
      answer.status === 200
        ? "The session answer is not what the Worker's schema describes."
        : answer.message,
      answer.status || undefined,
    );
  const { channels, ...identity } = session.data;
  document.identity = identity;
  if (!read) {
    document.channels = channels;
    return;
  }

  document.name = read.job.name;
  const uploads = new Map();
  for (const entry of plan(read.job, channels, token)) {
    const result =
      command === "queue"
        ? await send(entry, read.images, uploads, context)
        : { outcome: "would-send" };
    document.channels.push({
      ...entry.channel,
      requestId: entry.requestId,
      ...result,
      text: entry.text,
      image: entry.image,
    });
  }
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
    fs: { readFile, realpath, stat },
    runProcess,
    baseUrl: CONSOLE,
    timeoutMs: 60_000,
    ...overrides,
  };
  const secrets = [];
  const document = {
    ok: false,
    command: null,
    identity: null,
    channels: [],
    errors: [],
  };
  try {
    await execute(argv, deps, document, secrets);
  } catch (cause) {
    // Whatever went wrong, the caller still gets the JSON document it parses.
    document.errors.push({
      code: cause instanceof ScriptError ? cause.code : "unexpected",
      ...(cause?.status ? { status: cause.status } : {}),
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  document.ok =
    document.errors.length === 0 &&
    document.channels.every(
      ({ outcome }) =>
        outcome === undefined ||
        outcome === "created" ||
        outcome === "would-send",
    );
  return { exitCode: document.ok ? 0 : 1, document: redact(document, secrets) };
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
