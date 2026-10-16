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

// The Worker's limits for an announcement. They are checked here as well
// because an announcement is registered after the posts are queued: one the
// Worker refuses would leave the posts without it.
const ANNOUNCEMENT_MAX_TEXT = 1000;
const ANNOUNCEMENT_MAX_IMAGES = 4;

const jobSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    type: z.enum(["post", "story"]).default("post"),
    text: z.string().optional(),
    // `image` is the one-image form of `images`, so earlier jobs stay valid.
    image: z.string().optional(),
    images: z.array(z.string()).min(1).optional(),
    channels: z
      .array(z.string().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length),
    // The short version for Discord, posted once the post has gone out.
    announce: z
      .strictObject({
        text: z.string().refine((text) => {
          const length = text.trim().length;
          return length > 0 && length <= ANNOUNCEMENT_MAX_TEXT;
        }),
        images: z.array(z.string()).min(1).max(ANNOUNCEMENT_MAX_IMAGES),
      })
      .optional(),
  })
  .refine((job) => (job.image === undefined) !== (job.images === undefined))
  // A post needs a text and a story has none; the Worker's other rules are its own.
  .refine((job) => (job.type === "story") === (job.text === undefined));

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
  const leaves = inside === ".." || inside.startsWith(`..${path.sep}`);
  if (inside === "" || leaves || path.isAbsolute(inside))
    throw refuse("is not inside the folder of the job");
  return readFile(real).catch(() => {
    throw refuse("cannot be read");
  });
}

/** Width and height from the header of a PNG, or undefined for anything else. */
function pngSize(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    bytes.subarray(12, 16).toString("latin1") !== "IHDR"
  )
    return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The images of an announcement: PNGs, landscape or square, as the Worker takes them. */
async function readAnnouncementImages(folder, files) {
  const bytes = [];
  for (const file of files) {
    const image = await readImage(folder, file);
    const size = pngSize(image);
    if (!size || size.width < size.height)
      throw new Error(
        `The announcement image "${file}" has to be a PNG, landscape or square.`,
      );
    bytes.push(image);
  }
  return bytes;
}

/** The job file and its images. Nothing leaves the machine here. */
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
      `The job is not valid: a name, channels, image or images, a text (a post only) and an optional announce (a text of 1 to ${ANNOUNCEMENT_MAX_TEXT} characters and 1 to ${ANNOUNCEMENT_MAX_IMAGES} images), and nothing else, are expected (see: ${parsed.error.issues.map((issue) => issue.path.join(".") || "job").join(", ")}).`,
    );
  const folder = path.dirname(await realpath(jobPath));
  const { image, ...job } = parsed.data;
  const images = job.images ?? [image];
  const bytes = [];
  for (const file of images) bytes.push(await readImage(folder, file));
  const announce = job.announce && {
    ...job.announce,
    bytes: await readAnnouncementImages(folder, job.announce.images),
  };
  return { ...job, images, bytes, announce };
}

/** A request ID in the shape of a UUID, the same for every run with the same seed. */
function uuidFrom(seed) {
  const hash = createHash("sha256").update(seed).digest("hex");
  const variant = "89ab"[Number.parseInt(hash[16], 16) & 3];
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** The request ID of a channel: the same for every run of the same post. */
function requestId(clientId, { name, type }, channelId) {
  // The type is hashed for a story only, so the IDs of posts stay what they were.
  return uuidFrom(
    `${clientId}\n${name}\n${channelId}${type === "story" ? "\nstory" : ""}`,
  );
}

/** The request ID of the announcement of a post; no channel ID is empty, so it is apart. */
function announcementRequestId(clientId, { name }) {
  return uuidFrom(`${clientId}\n${name}\n\nannouncement`);
}

/** Uploads images one by one; stops at the first that fails and returns its answer. */
async function uploadAll(context, images) {
  const mediaIds = [];
  for (const body of images) {
    const upload = await ask(context, "/api/buffer/media", {
      method: "POST",
      type: "image/png",
      body,
    });
    if (upload.status !== 200 || upload.response?.mediaId === undefined)
      return { mediaIds, failed: upload };
    mediaIds.push(upload.response.mediaId);
  }
  return { mediaIds };
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
async function execute(argv, deps, secrets, document) {
  const { command, file, credential } = parseArguments(argv);
  document.command = command;
  const token = await readServiceToken(deps, credential);
  secrets.push(token.clientSecret, token.clientId);
  const context = { deps, token };
  if (command === "check")
    return {
      results: [
        { step: "session", ...(await ask(context, "/api/buffer/session")) },
      ],
    };

  const job = await readJob(file, deps.cwd);
  // These go out as they are: one that holds the token would publish it.
  const sent = [
    job.text ?? "",
    ...job.channels,
    ...job.images,
    ...(job.announce ? [job.announce.text, ...job.announce.images] : []),
  ];
  if (sent.some((value) => secrets.some((secret) => value.includes(secret))))
    throw new Error(
      "The text, a channel or an image path of the job contains the service token. Nothing was sent.",
    );
  const channels = job.channels.map((channelId) => ({
    channelId,
    requestId: requestId(token.clientId, job, channelId),
  }));
  const announce = job.announce && {
    requestId: announcementRequestId(token.clientId, job),
    text: job.announce.text,
    images: job.announce.images,
  };
  if (command === "preview")
    return {
      name: job.name,
      type: job.type,
      ...(job.text !== undefined && { text: job.text }),
      images: job.images,
      channels,
      ...(announce && { announce }),
    };

  // Each image once, in order, those of the announcement too; the first
  // failure stops the run before any post.
  const posted = await uploadAll(context, job.bytes);
  const announced =
    job.announce && !posted.failed
      ? await uploadAll(context, job.announce.bytes)
      : { mediaIds: [] };
  const upload = posted.failed ?? announced.failed;
  const results = [];
  for (const channel of channels)
    results.push(
      upload
        ? { ...channel, step: "upload", ...upload }
        : {
            ...channel,
            step: "post",
            ...(await ask(context, "/api/buffer/posts", {
              method: "POST",
              type: "application/json",
              body: JSON.stringify({
                requestId: channel.requestId,
                mediaIds: posted.mediaIds,
                channelId: channel.channelId,
                text: job.text,
                ...(job.type === "story" && { type: "story" }),
                mode: "addToQueue",
              }),
            })),
          },
    );
  if (!announce) return { name: job.name, results };
  return {
    name: job.name,
    results,
    announcement: await registerAnnouncement(
      context,
      announce,
      announced.mediaIds,
      results,
      job.text,
    ),
  };
}

/**
 * Registers the announcement for the posts that exist: those created now
 * (200) and those an earlier run created (409), as long as they carry the
 * job's text. The Worker posts it to Discord once one of them has gone out.
 */
async function registerAnnouncement(
  context,
  announce,
  mediaIds,
  results,
  postText,
) {
  const { requestId } = announce;
  const postRequestIds = results
    .filter(
      ({ step, status }) => step === "post" && [200, 409].includes(status),
    )
    .map((result) => result.requestId);
  if (postRequestIds.length === 0)
    return {
      requestId,
      step: "skipped",
      response: "No post exists, so nothing was announced.",
    };
  return {
    requestId,
    step: "announce",
    ...(await ask(context, "/api/buffer/announcements", {
      method: "POST",
      type: "application/json",
      body: JSON.stringify({
        requestId,
        text: announce.text,
        mediaIds,
        postRequestIds,
        // A 409 is also what a post edited under the same name gets; with the
        // text the Worker tells the two apart and refuses the edited one.
        postText,
      }),
    })),
  };
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
  const document = { command: null };
  try {
    Object.assign(document, await execute(argv, deps, secrets, document));
  } catch (cause) {
    // Whatever went wrong, the caller still gets the JSON document it parses.
    document.error = cause instanceof Error ? cause.message : String(cause);
  }
  // Only a post the Worker accepted counts; a failed upload leaves no post.
  const succeeded = ({ step, status }) =>
    step !== "upload" && status >= 200 && status < 300;
  const ok =
    document.error === undefined &&
    (document.results ?? []).every(succeeded) &&
    (document.announcement === undefined || succeeded(document.announcement));
  return {
    exitCode: ok ? 0 : 1,
    document: redact({ ok, ...document }, secrets),
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
