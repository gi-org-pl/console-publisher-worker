import { ClientError } from "./errors.mjs";

// The command line of the client: one command, a job file and a few options.

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

const badArguments = (message) => new ClientError("invalid-arguments", message);

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
