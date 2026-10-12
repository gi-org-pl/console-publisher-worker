import path from "node:path";
import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_SCHEDULE_DAYS,
  publishInputSchema,
} from "../../src/schemas/publishing.ts";
import { sha256 } from "./digest.mjs";
import { ClientError } from "./errors.mjs";
import { decodeText } from "./files.mjs";

// The job file: what is to be published, checked against the Worker's own
// limits before anything leaves the machine. The limits are the Worker's
// schema, imported above.

const DAY_MS = 86_400_000;

const badJob = (message) => new ClientError("invalid-job", message);

/**
 * `post.json` keeps its state in `post.state.json`.
 * @param {string} job
 */
export function defaultStatePath(job) {
  return `${job.replace(/\.json$/i, "")}.state.json`;
}

/**
 * Line endings become `\n`, a byte order mark and the surrounding space go.
 * @param {string} raw
 */
export function normalizeText(raw) {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
}

/**
 * Normalises a text and holds it to the Worker's own limits.
 * @param {string} raw
 * @param {string} label
 */
export function checkText(raw, label) {
  const result = publishInputSchema.shape.text.safeParse(normalizeText(raw));
  if (!result.success)
    throw badJob(`${label}: ${result.error.issues[0].message}.`);
  return result.data;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * The checks of the Worker's upload route, done before anything is sent.
 * @param {Uint8Array} bytes
 * @param {string} label
 */
export function inspectImage(bytes, label) {
  if (bytes.length > MAX_IMAGE_BYTES)
    throw badJob(
      `${label}: the image must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    );
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw badJob(`${label}: not a PNG file.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if ([width, height].some((size) => size < 1 || size > MAX_IMAGE_DIMENSION))
    throw badJob(
      `${label}: ${width}x${height} px, but each side must be 1-${MAX_IMAGE_DIMENSION} px.`,
    );
  return { width, height };
}

const overrides = z.record(z.string().min(1), z.string().min(1)).default({});

const jobSchema = z.strictObject({
  text: z.string().optional(),
  textFile: z.string().min(1).optional(),
  image: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1).optional(),
  channelText: overrides,
  channelTextFile: overrides,
  channelImage: overrides,
  dueAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Validates the shape of a job for one command. Files and channels are checked
 * later: files by the command, channels against the session.
 * @param {string} input
 * @param {string} command `queue` or `schedule`
 */
export function parseJob(input, command) {
  let json;
  try {
    json = JSON.parse(input.replace(/^﻿/, ""));
  } catch (cause) {
    throw badJob(`The job is not valid JSON: ${cause.message}`);
  }
  const result = jobSchema.safeParse(json);
  if (!result.success)
    throw badJob(
      result.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; "),
    );

  const job = result.data;
  if ((job.text === undefined) === (job.textFile === undefined))
    throw badJob('Give either "text" or "textFile".');
  const twice = Object.keys(job.channelText).filter((key) =>
    Object.hasOwn(job.channelTextFile, key),
  );
  if (twice.length > 0)
    throw badJob(
      `"channelText" and "channelTextFile" both name ${twice.join(", ")}.`,
    );
  if (command === "schedule" && job.dueAt === undefined)
    throw badJob(
      'schedule needs "dueAt", for example 2026-10-20T09:00:00+02:00.',
    );
  if (command !== "schedule" && job.dueAt !== undefined)
    throw badJob(
      `${command} takes no "dueAt": a queued post goes out at the channel's next Buffer slot. Use schedule for a fixed time.`,
    );
  return {
    ...job,
    // The Worker accepts UTC only (`Z`), so an offset is converted here.
    ...(job.dueAt === undefined
      ? {}
      : { dueAt: new Date(job.dueAt).toISOString() }),
  };
}

/**
 * The window every caller of the Worker shares. A service's own lead time is
 * known to the Worker only, which refuses an earlier time per channel.
 * @param {string} dueAt
 * @param {number} now
 */
export function checkDueAt(dueAt, now) {
  const due = Date.parse(dueAt);
  if (due <= now) throw badJob(`dueAt: ${dueAt} is not in the future.`);
  if (due > now + MAX_SCHEDULE_DAYS * DAY_MS)
    throw badJob(
      `dueAt: ${dueAt} is more than ${MAX_SCHEDULE_DAYS} days from now.`,
    );
}

/**
 * Reads the job and every file it names; nothing leaves the machine here.
 * @param {{ job: string, command: string }} options
 * @param {{ cwd: string, fs: { readFile: Function } }} deps
 */
export async function readJob(options, deps) {
  const jobPath = path.resolve(deps.cwd, options.job);
  const read = async (file, label, text = false) => {
    try {
      const bytes = await deps.fs.readFile(file);
      return text ? decodeText(bytes) : bytes;
    } catch (cause) {
      throw new ClientError(
        "invalid-job",
        `Cannot read ${label} (${file}): ${cause.code ?? cause.message}`,
      );
    }
  };

  const job = parseJob(await read(jobPath, "the job", true), options.command);

  const directory = path.dirname(jobPath);
  const textFrom = async (file, label) =>
    checkText(await read(path.resolve(directory, file), label, true), label);
  const images = new Map();
  const imageFrom = async (file, label) => {
    const imagePath = path.resolve(directory, file);
    if (!images.has(imagePath)) {
      const bytes = await read(imagePath, label);
      images.set(imagePath, {
        path: imagePath,
        bytes,
        sha256: sha256(bytes),
        ...inspectImage(bytes, label),
      });
    }
    return images.get(imagePath);
  };

  const content = {
    text:
      job.text === undefined
        ? await textFrom(job.textFile, "textFile")
        : checkText(job.text, "text"),
    image: await imageFrom(job.image, "image"),
    channelText: {},
    channelImage: {},
  };
  for (const [key, text] of Object.entries(job.channelText))
    content.channelText[key] = checkText(text, `channelText.${key}`);
  for (const [key, file] of Object.entries(job.channelTextFile))
    content.channelText[key] = await textFrom(file, `channelTextFile.${key}`);
  for (const [key, file] of Object.entries(job.channelImage))
    content.channelImage[key] = await imageFrom(file, `channelImage.${key}`);

  return { job, content };
}

/**
 * A text goes to the Worker and on to a public channel as it is. One that
 * holds a credential of this service would publish it - and the report,
 * which is cleared of both values, would not even show where it was.
 * @param {{ text: string, channelText: Record<string, string> }} content
 * @param {{ clientId: string, clientSecret: string }} credentials
 */
export function checkTextsForCredentials({ text, channelText }, credentials) {
  const found = [
    ["text", text],
    ...Object.entries(channelText).map(([key, value]) => [
      `the text for ${key}`,
      value,
    ]),
  ].flatMap(([label, value]) =>
    [
      ["Client Secret", credentials.clientSecret],
      ["Client ID", credentials.clientId],
    ]
      .filter(([, credential]) => value.includes(credential))
      .map(([name]) => `${label} contains the ${name} of this service`),
  );
  if (found.length > 0)
    throw new ClientError(
      "invalid-job",
      `${found.join("; ")}. Nothing was sent: take it out of the text, and replace the credential if the text was shown to anyone.`,
    );
}
