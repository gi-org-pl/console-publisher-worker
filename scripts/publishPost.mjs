import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sessionSchema, uploadSchema } from "../src/schemas/publishing.ts";
import {
  buildPostRequest,
  buildSessionRequest,
  buildUploadRequest,
  CHECK_BUFFER,
  ClientError,
  CREDENTIAL_NOT_FOUND,
  channelContent,
  checkCredentials,
  checkDueAt,
  checkText,
  classifyPost,
  contentDigest,
  credentialCommand,
  credentialsFromEnvironment,
  defaultStatePath,
  emptyState,
  inspectImage,
  isRefusal,
  MODES,
  parseArguments,
  parseCredentialOutput,
  parseJob,
  parseState,
  planEntry,
  redact,
  redactDeep,
  resolveBaseUrl,
  selectChannels,
  serializeState,
  sha256,
} from "./publishJob.mjs";

// Queues or schedules a post through the Worker as a service identity.
// Usage, the job format and the output are documented in the README
// ("Command-line client for services").

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_LENGTH = 500;
/** Outcomes of a channel that leave nothing to do. */
const DONE = ["would-send", "created", "already-created"];

/**
 * Runs a program and returns its exit code and stdout, never its stderr.
 * @param {{ file: string, args: string[], env: Record<string, string> }} command
 * @returns {Promise<{ code: number, stdout: string }>}
 */
export function runProcess({ file, args, env }) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
        }),
    );
  });
}

/** The environment wins; the credential store is asked only without it. */
async function resolveCredentials(options, deps) {
  const fromEnvironment = credentialsFromEnvironment(deps.env);
  if (fromEnvironment)
    return checkCredentials(fromEnvironment, "the environment");

  if (!options.credential) {
    const set = ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].filter(
      (name) => deps.env[name],
    );
    throw new ClientError(
      "missing-credentials",
      `Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET${set.length === 1 ? ` (only ${set[0]} is set)` : ""}, or pass --credential <name> on Windows.`,
    );
  }
  if (deps.platform !== "win32")
    throw new ClientError(
      "credential-unavailable",
      "--credential reads the Windows credential store. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
    );

  const { code, stdout } = await deps.runProcess(
    credentialCommand(options.credential),
  );
  if (code === CREDENTIAL_NOT_FOUND)
    throw new ClientError(
      "credential-unavailable",
      `The Windows credential store has no generic credential named "${options.credential}".`,
    );
  if (code !== 0)
    throw new ClientError(
      "credential-unavailable",
      `Reading the Windows credential store failed (PowerShell exit code ${code}).`,
    );
  return checkCredentials(
    parseCredentialOutput(stdout),
    `the credential "${options.credential}"`,
  );
}

function describeFailure(cause, timeoutMs) {
  if (cause?.name === "TimeoutError" || cause?.name === "AbortError")
    return `no answer within ${timeoutMs / 1000} s`;
  const detail = cause?.cause?.code ?? cause?.cause?.message;
  return `${cause?.message ?? cause}${detail ? ` (${detail})` : ""}`;
}

/**
 * Sends one request. Whatever happens comes back as `{ status, data, message }`
 * with status 0 when no answer arrived. Redirects are not followed: the
 * credential headers must never travel to another host.
 */
async function callWorker(context, request) {
  let response;
  try {
    response = await context.fetch(new URL(request.path, context.baseUrl), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(context.timeoutMs),
    });
  } catch (cause) {
    return {
      status: 0,
      message: `No answer from ${context.baseUrl}: ${describeFailure(cause, context.timeoutMs)}.`,
    };
  }

  const { status } = response;
  if (status >= 300 && status < 400)
    return {
      status,
      message:
        "Redirected instead of answered: Cloudflare Access did not accept the credentials.",
    };

  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = undefined;
  }
  if (typeof data?.message === "string") {
    // The credentials are taken out before the message is cut: a cut through
    // one of them would leave a part that no later redaction can match.
    const message = redact(data.message, [
      request.headers["CF-Access-Client-Secret"],
      request.headers["CF-Access-Client-Id"],
    ]);
    return { status, data, message: message.slice(0, MAX_MESSAGE_LENGTH) };
  }
  return {
    status,
    data,
    message: `HTTP ${status} without a message from the Worker.`,
  };
}

async function openSession(context, credentials, log) {
  const answer = await callWorker(context, buildSessionRequest(credentials));
  log(`session: ${answer.status || "no answer"}`);
  if (answer.status !== 200)
    throw new ClientError(
      "session-failed",
      answer.message,
      answer.status || undefined,
    );
  const session = sessionSchema.safeParse(answer.data);
  if (!session.success)
    throw new ClientError(
      "session-failed",
      "The session answer is not what the Worker's schema describes.",
      200,
    );
  const { channels, ...identity } = session.data;
  return { identity, channels };
}

/** Reads the job and every file it names; nothing leaves the machine here. */
async function prepareJob(options, deps, origin) {
  const jobPath = path.resolve(deps.cwd, options.job);
  const read = async (file, label, encoding) => {
    try {
      return await deps.fs.readFile(file, encoding);
    } catch (cause) {
      throw new ClientError(
        "invalid-job",
        `Cannot read ${label} (${file}): ${cause.code ?? cause.message}`,
      );
    }
  };

  const job = parseJob(await read(jobPath, "the job", "utf8"), options.command);
  if (job.dueAt) checkDueAt(job.dueAt, deps.now());

  const directory = path.dirname(jobPath);
  const textFrom = async (file, label) =>
    checkText(await read(path.resolve(directory, file), label, "utf8"), label);
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

  const statePath = path.resolve(
    deps.cwd,
    options.state ?? defaultStatePath(options.job),
  );
  let state = emptyState(origin);
  let stateExists = true;
  try {
    state = parseState(await deps.fs.readFile(statePath, "utf8"));
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause instanceof ClientError
        ? cause
        : new ClientError(
            "invalid-state",
            `Cannot read the state file (${statePath}): ${cause.code ?? cause.message}`,
          );
    }
    stateExists = false;
  }
  return { job, content, statePath, state, stateExists };
}

/**
 * Uploads and posts for one channel. The state is written before each request,
 * so a run that dies in the middle leaves a trace of how far it got.
 */
async function sendChannel(plan, run) {
  const { context, credentials, save, log } = run;
  const { channel, entry } = plan;
  const label = `${channel.service} (${channel.id})`;
  const set = (fields) => {
    for (const key of ["mediaId", "postId", "status", "message"])
      delete entry[key];
    Object.assign(entry, fields);
  };
  // The step written before a request. When the write fails the request is
  // not sent, so the step is taken back: a later write, of another channel,
  // must not record a step this channel never reached.
  const mark = async (fields) => {
    const before = { ...entry };
    set(fields);
    try {
      await save();
    } catch (cause) {
      for (const key of Object.keys(entry)) delete entry[key];
      Object.assign(entry, before);
      throw cause;
    }
  };

  let { mediaId } = entry;
  if (entry.step !== "uploaded" || !mediaId) {
    await mark({ step: "uploading" });
    const answer = await callWorker(
      context,
      buildUploadRequest(credentials, plan.image.bytes),
    );
    log(`${label}: upload ${answer.status || "no answer"}`);
    const uploaded =
      answer.status === 200 ? uploadSchema.safeParse(answer.data) : undefined;
    if (!uploaded?.success) {
      const outcome = isRefusal(answer.status) ? "refused" : "failed";
      const failure = {
        ...(answer.status ? { status: answer.status } : {}),
        message: `Upload: ${answer.status === 200 ? "the Worker answered without a media ID." : answer.message}`,
      };
      set({ step: outcome, ...failure });
      await save();
      return { outcome, ...failure };
    }
    mediaId = uploaded.data.mediaId;
    set({ step: "uploaded", mediaId });
    await save();
  }

  const request = buildPostRequest(credentials, {
    requestId: entry.requestId,
    mediaId,
    channelId: channel.id,
    text: plan.text,
    mode: run.mode,
    ...(run.dueAt ? { dueAt: run.dueAt } : {}),
  });
  await mark({ step: "posting", mediaId });
  const answer = await callWorker(context, request);
  log(`${label}: post ${answer.status || "no answer"}`);

  const { outcome, ...result } = classifyPost(answer);
  if (result.status === 0) delete result.status;
  // An unknown result keeps the step at "posting", which blocks a repeat.
  set({
    step: outcome === "unknown" ? "posting" : outcome,
    mediaId,
    ...result,
  });
  try {
    await save();
  } catch (cause) {
    run.errors.push({
      code: cause.code,
      message: `${cause.message} The result of ${label} (${outcome}) is not in the state file: do not run this job again before the file is fixed.`,
    });
  }
  return { outcome, ...result };
}

async function execute(argv, deps, document, secrets, log) {
  const options = parseArguments(argv);
  document.command = options.command;
  document.sent = options.send;
  document.url = resolveBaseUrl(options.url);

  // Before the job is read, so an error about the job, its files or its state
  // is free of both values also when they come from the credential store.
  const credentials = await resolveCredentials(options, deps);
  secrets.push(credentials.clientSecret, credentials.clientId);

  const prepared =
    options.command === "check"
      ? undefined
      : await prepareJob(options, deps, document.url);
  // A post created at one address says nothing about another: a state made
  // against a local Worker must not make a run against the Console skip a post.
  if (prepared && prepared.state.origin !== document.url)
    throw new ClientError(
      "state-mismatch",
      `The state file (${prepared.statePath}) was made against ${prepared.state.origin} and this run goes to ${document.url}. Use another state file (--state).`,
    );

  const context = {
    fetch: deps.fetch,
    baseUrl: document.url,
    timeoutMs: deps.timeoutMs,
  };
  const session = await openSession(context, credentials, log);
  document.identity = session.identity;
  if (!prepared) {
    document.channels = session.channels;
    return;
  }

  const { job, content, statePath, state } = prepared;
  const mode = MODES[options.command];
  document.mode = mode;
  if (job.dueAt) document.dueAt = job.dueAt;
  document.state = statePath;

  const plans = selectChannels(job, session.channels).map((channel) => {
    const { text, image } = channelContent(content, channel);
    const digest = contentDigest({
      mode,
      dueAt: job.dueAt,
      text,
      imageSha256: image.sha256,
    });
    return {
      channel,
      text,
      image,
      ...planEntry(state.channels[channel.id], digest, deps.newId),
    };
  });

  const changed = plans.filter((plan) => plan.action === "changed");
  if (changed.length > 0) {
    const names = (step) =>
      changed
        .filter((plan) => plan.entry.step === step)
        .map((plan) => `${plan.channel.service} (${plan.channel.id})`)
        .join(", ");
    const created = names("created");
    const sent = names("posting");
    throw new ClientError(
      "state-mismatch",
      [
        created && `The job changed after a post was created for ${created}.`,
        sent &&
          `The job changed after a post for ${sent} was sent with no recorded result: what may be in Buffer is the earlier content. ${CHECK_BUFFER}`,
        "A new post needs a new state file (--state).",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  for (const plan of plans)
    state.channels[plan.channel.id] = Object.assign(plan.entry, {
      service: plan.channel.service,
    });
  let stateOnDisk = prepared.stateExists;
  const save = async () => {
    try {
      const data = serializeState(redactDeep(state, secrets));
      if (stateOnDisk) {
        // A later write replaces the file in one step: a run that dies in the
        // middle of it leaves the last complete state, not half of a new one.
        const draft = `${statePath}.tmp`;
        await deps.fs.writeFile(draft, data, { flag: "w", flush: true });
        await deps.fs.rename(draft, statePath);
      } else {
        // The first write must not replace a file another run has just made.
        await deps.fs.writeFile(statePath, data, { flag: "wx" });
      }
      stateOnDisk = true;
    } catch (cause) {
      throw new ClientError(
        "state-failed",
        cause.code === "EEXIST"
          ? `Another run created the state file (${statePath}) in the meantime. Run again.`
          : `Cannot write the state file (${statePath}): ${cause.code ?? cause.message}.`,
      );
    }
  };
  await save();

  const run = {
    context,
    credentials,
    save,
    log,
    mode,
    dueAt: job.dueAt,
    errors: document.errors,
  };
  for (const plan of plans) {
    const { channel, entry } = plan;
    let result;
    if (plan.action === "already-created") {
      result = { outcome: "already-created", postId: entry.postId };
    } else if (plan.action === "unknown") {
      result = {
        outcome: "unknown",
        ...(entry.status ? { status: entry.status } : {}),
        message:
          entry.message ??
          `An earlier run sent this post and recorded no result. ${CHECK_BUFFER}`,
      };
    } else if (!options.send) {
      result = { outcome: "would-send" };
    } else {
      try {
        result = await sendChannel(plan, run);
      } catch (cause) {
        // Thrown before the post request went out, so nothing was created.
        result = {
          outcome: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
    document.channels.push({
      id: channel.id,
      name: channel.name,
      service: channel.service,
      requestId: entry.requestId,
      ...result,
      text: plan.text,
      image: plan.image.path,
    });
  }
  if (!options.send) log("dry run: nothing was sent; pass --send to send");
}

/**
 * A channel in the output. `check` lists the session's channels as they are;
 * `queue` and `schedule` add what happened to each selected one.
 * @typedef {object} ChannelReport
 * @property {string} id
 * @property {string} name
 * @property {string} service
 * @property {string} [requestId]
 * @property {"would-send" | "created" | "already-created" | "refused" | "failed" | "unknown"} [outcome]
 * @property {string} [postId]
 * @property {number} [status]
 * @property {string} [message]
 * @property {string} [text]
 * @property {string} [image]
 */

/**
 * The JSON document on stdout.
 * @typedef {object} Report
 * @property {boolean} ok
 * @property {string | null} command
 * @property {boolean} sent
 * @property {string | null} url
 * @property {Record<string, string> | null} identity
 * @property {string} [mode]
 * @property {string} [dueAt]
 * @property {string} [state]
 * @property {ChannelReport[]} channels
 * @property {{ code: string, status?: number, message: string }[]} errors
 */

/**
 * The whole command. Returns the exit code and the one JSON document that
 * belongs on stdout; everything it reads from outside can be replaced.
 * @param {string[]} argv
 * @param {object} [overrides] replacements for the defaults below, for tests
 * @returns {Promise<{ exitCode: number, document: Report }>}
 */
export async function run(argv, overrides = {}) {
  const deps = {
    env: process.env,
    fetch: globalThis.fetch,
    fs: { readFile, rename, writeFile },
    log: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    newId: () => randomUUID(),
    platform: process.platform,
    runProcess,
    cwd: process.cwd(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...overrides,
  };
  // Known before anything can fail, so no early error can carry them either.
  const secrets = [
    deps.env.CF_ACCESS_CLIENT_SECRET,
    deps.env.CF_ACCESS_CLIENT_ID,
  ].filter(Boolean);
  /** @type {Report} */
  const document = {
    ok: false,
    command: null,
    sent: false,
    url: null,
    identity: null,
    channels: [],
    errors: [],
  };
  const log = (line) => {
    try {
      deps.log(redact(line, secrets));
    } catch {
      // A closed stderr must not change what is reported about a post.
    }
  };

  try {
    await execute(argv, deps, document, secrets, log);
  } catch (cause) {
    // Whatever went wrong, the caller still gets the JSON document it parses.
    document.errors.push(
      cause instanceof ClientError
        ? {
            code: cause.code,
            ...(cause.status ? { status: cause.status } : {}),
            message: cause.message,
          }
        : {
            code: "unexpected",
            message: cause instanceof Error ? cause.message : String(cause),
          },
    );
  }

  document.ok =
    document.errors.length === 0 &&
    document.channels.every(
      (channel) =>
        channel.outcome === undefined || DONE.includes(channel.outcome),
    );
  // The lists come last, after whatever the run added about itself.
  const { channels, errors, ...head } = document;
  return {
    exitCode: document.ok ? 0 : 1,
    document: redactDeep({ ...head, channels, errors }, secrets),
  };
}

const isEntryPoint =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href);
if (isEntryPoint) {
  const { exitCode, document } = await run(process.argv.slice(2));
  // Stdout carries only the JSON result, so callers can parse it as is.
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exitCode = exitCode;
}
