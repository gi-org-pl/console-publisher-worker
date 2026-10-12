import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { MODES, parseArguments, resolveBaseUrl } from "./arguments.mjs";
import { checkChannelIds } from "./channels.mjs";
import { resolveCredentials } from "./credentials.mjs";
import { ClientError } from "./errors.mjs";
import { checkDueAt, checkTextsForCredentials, readJob } from "./job.mjs";
import { planRun } from "./plan.mjs";
import { runProcess } from "./process.mjs";
import { createLog, redactDeep } from "./redaction.mjs";
import { reportChannel } from "./report.mjs";
import { createStateWriter, readState, resolveStatePath } from "./state.mjs";
import { openSession } from "./worker.mjs";

// The whole command, step by step: arguments, credentials, the job and its
// state, the session, the plan, the state on disk, then one report per
// channel. Each step lives in a module of its own.

const REQUEST_TIMEOUT_MS = 60_000;
/** Outcomes of a channel that leave nothing to do. */
const DONE = ["would-send", "created", "already-created"];

/** Reads the job, its files and its state; nothing leaves the machine here. */
async function prepareJob(options, deps, origin) {
  const { job, content } = await readJob(options, deps);
  const statePath = resolveStatePath(options, deps);
  const { state, stateExists } = await readState(statePath, origin, deps);
  // A job that was never run is held to its time before any request. One with
  // a state may be run again after that time, to read what happened: there
  // the time holds back only the channels that would still be sent.
  if (job.dueAt && !stateExists) checkDueAt(job.dueAt, deps.now());
  return { job, content, statePath, state, stateExists };
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
  if (prepared) checkTextsForCredentials(prepared.content, credentials);
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
  checkChannelIds(session.channels, credentials);

  const { job, statePath, state, stateExists } = prepared;
  const mode = MODES[options.command];
  document.mode = mode;
  if (job.dueAt) document.dueAt = job.dueAt;
  document.state = statePath;

  const { plans, targets, untimely } = planRun({
    options,
    deps,
    session,
    prepared,
    mode,
  });
  const { save, unsaved } = createStateWriter({
    state,
    statePath,
    stateExists,
    deps,
    secrets,
    errors: document.errors,
  });
  // The state is written before anything is planned to go out, so the request
  // IDs a dry run prints are the ones a later send uses. A run in which no
  // channel would be sent has nothing new to record: it reports what the
  // state holds, also from a disk that cannot be written.
  if (plans.some((plan) => plan.decision === "send")) await save();

  const sending = {
    context,
    credentials,
    save,
    log,
    mode,
    dueAt: job.dueAt,
    errors: document.errors,
    unsaved,
  };
  for (const plan of plans)
    document.channels.push(
      await reportChannel(plan, {
        send: options.send,
        targets,
        untimely,
        sending,
      }),
    );
  // One more try for a result the file still lacks, now that nothing else is
  // left to send. When it fails too, the error stays as it was reported.
  if (unsaved.length > 0) await save().catch(() => {});
  if (!options.send) log("dry run: nothing was sent; pass --send to send");
}

/**
 * The whole command. Returns the exit code and the one JSON document that
 * belongs on stdout; everything it reads from outside can be replaced.
 * @param {string[]} argv
 * @param {object} [overrides] replacements for the defaults below, for tests
 * @returns {Promise<{ exitCode: number, document: import("./report.mjs").Report }>}
 */
export async function run(argv, overrides = {}) {
  const deps = {
    env: process.env,
    fetch: globalThis.fetch,
    fs: { readFile, rename, unlink, writeFile },
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
  /** @type {import("./report.mjs").Report} */
  const document = {
    ok: false,
    command: null,
    sent: false,
    url: null,
    identity: null,
    channels: [],
    errors: [],
  };
  const log = createLog(deps.log, secrets);

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
