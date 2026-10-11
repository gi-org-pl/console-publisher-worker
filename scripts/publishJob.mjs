import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_SCHEDULE_DAYS,
  publishInputSchema,
  publishResultSchema,
  SERVICE_CLIENT_ID,
} from "../src/schemas/publishing.ts";

// The pure part of the service client: arguments, the job, the requests and the
// state file. `publishPost.mjs` does the reading, the HTTP and the output.
// The request contract and its limits are the Worker's own schema, imported above.

export const DEFAULT_URL = "https://console.gi.org.pl";
export const USAGE =
  "Usage: node scripts/publishPost.mjs check | queue <job.json> | schedule <job.json> [--send] [--state <file>] [--url <base URL>] [--credential <name>]";

/** One mode per command. There is deliberately no command for `shareNow`. */
export const MODES = { queue: "addToQueue", schedule: "customScheduled" };
const COMMANDS = ["check", ...Object.keys(MODES)];
const VALUE_OPTIONS = ["--state", "--url", "--credential"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const DAY_MS = 86_400_000;

/** A failure the caller reports in the JSON document under `errors`. */
export class ClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.status = status;
  }
}

const badArguments = (message) => new ClientError("invalid-arguments", message);
const badJob = (message) => new ClientError("invalid-job", message);

/**
 * Parses `check | queue <job> | schedule <job>` and the options.
 * @param {string[]} argv
 */
export function parseArguments(argv) {
  /** @type {{ command: string, job: string | undefined, send: boolean, state: string | undefined, url: string, credential: string | undefined }} */
  const options = {
    command: "",
    job: undefined,
    send: false,
    state: undefined,
    url: DEFAULT_URL,
    credential: undefined,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--send") {
      options.send = true;
    } else if (VALUE_OPTIONS.includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw badArguments(`${argument} needs a value.`);
      options[argument.slice(2)] = value;
    } else if (argument.startsWith("--")) {
      throw badArguments(`Unknown option ${argument}.`);
    } else {
      positional.push(argument);
    }
  }

  const [command, job, extra] = positional;
  if (command === undefined) throw badArguments(USAGE);
  if (!COMMANDS.includes(command))
    throw badArguments(`Unknown command ${command}. ${USAGE}`);
  options.command = command;

  if (command === "check") {
    if (job !== undefined) throw badArguments(`Unexpected argument ${job}.`);
    if (options.send || options.state !== undefined)
      throw badArguments("check takes neither --send nor --state.");
    return options;
  }
  if (job === undefined)
    throw badArguments(`${command} needs a job file. ${USAGE}`);
  if (extra !== undefined) throw badArguments(`Unexpected argument ${extra}.`);
  options.job = job;
  return options;
}

/**
 * The origin requests go to. The credentials travel with every request, so the
 * only hosts accepted are the Console and this machine (a local `wrangler dev`).
 * @param {string} value
 */
export function resolveBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badArguments("--url is not a URL.");
  }
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw badArguments(
      "--url takes an origin only, for example http://localhost:8787.",
    );
  const local =
    LOOPBACK_HOSTS.includes(url.hostname) &&
    ["http:", "https:"].includes(url.protocol);
  if (url.origin !== DEFAULT_URL && !local)
    throw badArguments(
      `--url may only be ${DEFAULT_URL} or a loopback address (localhost, 127.0.0.1, [::1]), because the credentials are sent to it.`,
    );
  return url.origin;
}

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
 * @typedef {{ id: string, name: string, service: string }} Channel
 */

/** A job names a channel by its id or by its network; the id wins. */
function findOverride(values, channel) {
  for (const key of [channel.id, channel.service])
    if (Object.hasOwn(values, key)) return values[key];
  return undefined;
}

/**
 * The session's channels this job posts to. A name that matches nothing is a
 * mistake in the job, so nothing is sent until it is fixed.
 * @param {{ channels?: string[], channelText: object, channelTextFile: object, channelImage: object }} job
 * @param {Channel[]} available
 * @returns {Channel[]}
 */
export function selectChannels(job, available) {
  const matches = (key, channel) =>
    channel.id === key || channel.service === key;
  // The state keeps one entry per channel id. An id listed twice would get two
  // request ids and two posts, so a session like that is refused as a whole.
  const repeated = available
    .map((channel) => channel.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (repeated.length > 0)
    throw new ClientError(
      "duplicate-channel",
      `The session lists a channel more than once: ${[...new Set(repeated)].join(", ")}. Nothing is sent until the Worker's channel list is fixed.`,
    );
  const problems = [];
  let selected = available;
  if (job.channels) {
    const wanted = job.channels;
    for (const key of wanted)
      if (!available.some((channel) => matches(key, channel)))
        problems.push(`channels: "${key}" is not a channel of this session`);
    selected = available.filter((channel) =>
      wanted.some((key) => matches(key, channel)),
    );
  }
  for (const name of ["channelText", "channelTextFile", "channelImage"])
    for (const key of Object.keys(job[name]))
      if (!selected.some((channel) => matches(key, channel)))
        problems.push(`${name}: "${key}" matches no selected channel`);

  if (problems.length > 0)
    throw new ClientError(
      "unknown-channel",
      `${problems.join("; ")}. The session has: ${available
        .map((channel) => `${channel.service} (${channel.id})`)
        .join(", ")}.`,
    );
  return selected;
}

/**
 * What one channel gets: its own text and image when the job has them.
 * @template T
 * @param {{ text: string, image: T, channelText: Record<string, string>, channelImage: Record<string, T> }} content
 * @param {Channel} channel
 */
export function channelContent(content, channel) {
  return {
    text: findOverride(content.channelText, channel) ?? content.text,
    image: findOverride(content.channelImage, channel) ?? content.image,
  };
}

/** @param {Uint8Array | string} value */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Ties a channel's state to what was prepared for it, so a job edited after a
 * post was created is noticed instead of being reported as already published.
 * @param {{ mode: string, dueAt?: string, text: string, imageSha256: string }} content
 */
export function contentDigest({ mode, dueAt, text, imageSha256 }) {
  return sha256(JSON.stringify([mode, dueAt ?? null, text, imageSha256]));
}

/**
 * @typedef {{ clientId: string, clientSecret: string }} Credentials
 */

/**
 * Both variables or nothing: half a pair never reaches a request.
 * @param {Record<string, string | undefined>} env
 * @returns {Credentials | undefined}
 */
export function credentialsFromEnvironment(env) {
  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * Refuses a pair that cannot be a service token, without repeating its values.
 * @param {Credentials} credentials
 * @param {string} source where the pair came from, for the message
 */
export function checkCredentials(credentials, source) {
  if (!SERVICE_CLIENT_ID.test(credentials.clientId))
    throw new ClientError(
      "invalid-credentials",
      `The Client ID from ${source} is not a service token Client ID (32 hexadecimal characters and ".access").`,
    );
  if (!/^[\x21-\x7e]+$/.test(credentials.clientSecret))
    throw new ClientError(
      "invalid-credentials",
      `The Client Secret from ${source} is empty or holds spaces or other characters a header cannot carry.`,
    );
  return credentials;
}

/** The exit code of the credential script when the store has no such entry. */
export const CREDENTIAL_NOT_FOUND = 3;

// Reads one generic credential through CredRead and prints it as Base64 of a
// JSON object, so no character of the secret depends on the console code page.
// The here-string terminator below has to stay at the start of its line.
const CREDENTIAL_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace Gi -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
'@
$ptr = [IntPtr]::Zero
if (-not [Gi.Cred]::CredRead($env:PUBLISH_POST_CREDENTIAL, 1, 0, [ref]$ptr)) { exit ${CREDENTIAL_NOT_FOUND} }
try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Gi.Cred+CREDENTIAL])
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
  $json = ConvertTo-Json -Compress @{ clientId = [string]$c.UserName; clientSecret = [string]$secret }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
} finally {
  [Gi.Cred]::CredFree($ptr)
}
`;

/**
 * The process that reads a generic credential from the Windows credential
 * store. The name travels in the environment, never inside the script text.
 * @param {string} name
 */
export function credentialCommand(name) {
  return {
    file: "powershell",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(CREDENTIAL_SCRIPT, "utf16le").toString("base64"),
    ],
    env: { PUBLISH_POST_CREDENTIAL: name },
  };
}

/**
 * @param {string} stdout what the credential script printed
 * @returns {Credentials}
 */
export function parseCredentialOutput(stdout) {
  try {
    const { clientId, clientSecret } = JSON.parse(
      Buffer.from(stdout.trim(), "base64").toString("utf8"),
    );
    if (typeof clientId === "string" && typeof clientSecret === "string")
      return { clientId, clientSecret };
  } catch {
    // Reported below; the output may hold the secret and is never quoted.
  }
  throw new ClientError(
    "credential-unavailable",
    "The answer of the credential store could not be read.",
  );
}

/**
 * Removes the credentials from a text.
 * @param {string} text
 * @param {string[]} secrets
 */
export function redact(text, secrets) {
  let clean = text;
  for (const secret of secrets)
    if (secret) clean = clean.replaceAll(secret, "[redacted]");
  return clean;
}

/**
 * Removes the credentials from every string of a JSON value, keys included.
 * The output document and the state file both pass through here.
 * @template T
 * @param {T} value
 * @param {string[]} secrets
 * @returns {T}
 */
export function redactDeep(value, secrets) {
  if (typeof value === "string")
    return /** @type {T} */ (redact(value, secrets));
  if (Array.isArray(value))
    return /** @type {T} */ (value.map((item) => redactDeep(item, secrets)));
  if (value !== null && typeof value === "object")
    return /** @type {T} */ (
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key, secrets),
          redactDeep(item, secrets),
        ]),
      )
    );
  return value;
}

/**
 * The two headers Access checks. A service sends no `Origin`.
 * @param {Credentials} credentials
 */
function accessHeaders({ clientId, clientSecret }) {
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

/** @param {Credentials} credentials */
export function buildSessionRequest(credentials) {
  return {
    method: "GET",
    path: "/api/buffer/session",
    headers: accessHeaders(credentials),
  };
}

/**
 * @param {Credentials} credentials
 * @param {Uint8Array} bytes the PNG
 */
export function buildUploadRequest(credentials, bytes) {
  return {
    method: "POST",
    path: "/api/buffer/media",
    headers: { ...accessHeaders(credentials), "Content-Type": "image/png" },
    body: bytes,
  };
}

/**
 * The body is checked against the Worker's schema, so a request it would turn
 * down as malformed is never sent.
 * @param {Credentials} credentials
 * @param {{ requestId: string, mediaId: string, channelId: string, text: string, mode: string, dueAt?: string }} input
 */
export function buildPostRequest(credentials, input) {
  if (!Object.values(MODES).includes(input.mode))
    throw new ClientError("unexpected", `Mode ${input.mode} is not offered.`);
  const result = publishInputSchema.safeParse(input);
  if (!result.success)
    throw new ClientError(
      "unexpected",
      `The post request does not match the Worker's schema: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  return {
    method: "POST",
    path: "/api/buffer/posts",
    headers: {
      ...accessHeaders(credentials),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(result.data),
  };
}

/**
 * An answer that settles the matter: the request was turned down and nothing
 * was created. A redirect comes from Access, before the Worker. 409 is not in
 * this group: the Worker has seen the request ID and cannot say what became of it.
 * @param {number} status
 */
export function isRefusal(status) {
  return status >= 300 && status < 500 && status !== 409;
}

export const CHECK_BUFFER =
  "The post may exist. Look in Buffer; this channel is not sent again with this state file.";

/**
 * What the answer to a post request means for the channel.
 * @param {{ status: number, data?: unknown, message: string }} answer
 * @returns {{ outcome: "created", postId: string } | { outcome: "refused" | "unknown", status: number, message: string }}
 */
export function classifyPost(answer) {
  if (answer.status === 200) {
    const result = publishResultSchema.safeParse(answer.data);
    if (result.success)
      return { outcome: "created", postId: result.data.postId };
    return {
      outcome: "unknown",
      status: 200,
      message: `The Worker answered without a post ID. ${CHECK_BUFFER}`,
    };
  }
  if (isRefusal(answer.status))
    return {
      outcome: "refused",
      status: answer.status,
      message: answer.message,
    };
  return {
    outcome: "unknown",
    status: answer.status,
    message: `${answer.message} ${CHECK_BUFFER}`,
  };
}

/**
 * Where a channel stands. `posting` means a post request went out and no
 * created post was recorded for it.
 */
const STEPS = [
  "prepared",
  "uploading",
  "uploaded",
  "posting",
  "created",
  "refused",
  "failed",
];

const entrySchema = z
  .strictObject({
    service: z.string().optional(),
    requestId: z.uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    step: z.enum(STEPS),
    mediaId: z.uuid().optional(),
    postId: z.string().min(1).optional(),
    status: z.number().int().optional(),
    message: z.string().optional(),
  })
  .refine((entry) => entry.step !== "created" || entry.postId !== undefined, {
    message: 'a "created" entry needs a postId',
  });

const stateSchema = z.strictObject({
  version: z.literal(1),
  channels: z.record(z.string().min(1), entrySchema),
});

/**
 * @typedef {z.infer<typeof entrySchema>} StateEntry
 * @typedef {z.infer<typeof stateSchema>} State
 */

/** @returns {State} */
export function emptyState() {
  return { version: 1, channels: {} };
}

/**
 * A state file that cannot be read is never replaced: it may hold the request
 * IDs of posts that exist.
 * @param {string} input
 * @returns {State}
 */
export function parseState(input) {
  let json;
  try {
    json = JSON.parse(input);
  } catch (cause) {
    throw new ClientError(
      "invalid-state",
      `The state file is not valid JSON: ${cause.message}`,
    );
  }
  const result = stateSchema.safeParse(json);
  if (!result.success)
    throw new ClientError(
      "invalid-state",
      `The state file is not a state of this client: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  return result.data;
}

/** @param {State} state */
export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Decides what to do with one channel from its earlier state.
 *
 * - `send`: nothing is in doubt; the entry carries the request ID to use.
 * - `already-created`: the post exists, for exactly this content.
 * - `unknown`: an earlier post request has no recorded result. It is never
 *   repeated on its own.
 * - `changed`: the post exists, but for other content than the job now holds.
 *
 * @param {StateEntry | undefined} entry
 * @param {string} digest of the content prepared for the channel now
 * @param {() => string} newId
 * @returns {{ action: "send" | "already-created" | "unknown" | "changed", entry: StateEntry }}
 */
export function planEntry(entry, digest, newId) {
  if (!entry)
    return {
      action: "send",
      entry: { requestId: newId(), digest, step: "prepared" },
    };
  if (entry.step === "posting") return { action: "unknown", entry };
  if (entry.step === "created")
    return {
      action: entry.digest === digest ? "already-created" : "changed",
      entry,
    };
  if (entry.digest === digest) return { action: "send", entry };
  // Nothing was created for the old content, so the request ID is still free.
  return {
    action: "send",
    entry: { requestId: entry.requestId, digest, step: "prepared" },
  };
}
