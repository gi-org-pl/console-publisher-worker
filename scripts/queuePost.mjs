import { readFile, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sessionSchema } from "../src/schemas/publishing.ts";
import { ask, send } from "./queue-post/console.mjs";
import { runProcess } from "./queue-post/credentialStores.mjs";
import { ScriptError } from "./queue-post/errors.mjs";
import { readJob } from "./queue-post/job.mjs";
import { plan } from "./queue-post/plan.mjs";
import { readServiceToken, redact } from "./queue-post/serviceToken.mjs";

// Queues one post per channel through the Worker as a service identity.
// Usage, the job and the output are in the README ("Queueing a post from the
// command line"). The script keeps no state: the request ID of a channel
// follows from the name of the post, so the Worker recognises a second run.
//
// This file is the run from the arguments to the JSON document. The steps it
// calls are in `queue-post/`: the job, the plan per channel, the requests to
// the Console, and the service token with the stores it may come from.

const CONSOLE = "https://console.gi.org.pl";
const USAGE =
  "Usage: node scripts/queuePost.mjs check | preview <job.json> | queue <job.json> [--credential <name>]";

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
