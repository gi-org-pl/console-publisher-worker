import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SERVICE_CLIENT_ID } from "../src/schemas/publishing.ts";

// Where the service token of a run comes from: two environment variables,
// or the credential store of the system when `--credential <name>` is given.

/** @typedef {{ clientId: string, clientSecret: string }} ServiceToken */
/** @typedef {{ file: string, args: string[], env: Record<string, string> }} Command */

/** A failure the script reports instead of a stack trace. */
export class ScriptError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const unavailable = (message) =>
  new ScriptError("credential-unavailable", message);

/**
 * Runs a program with exactly the given environment and returns its exit code
 * and stdout, never its stderr.
 * @param {Command} command
 * @returns {Promise<{ code: number, stdout: string }>}
 */
export function runProcess({ file, args, env }) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, windowsHide: true, timeout: 30_000 },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
        }),
    );
  });
}

/**
 * Windows: a generic credential whose user name is the Client ID and whose
 * password is the Client Secret, read by `readCredential.ps1`. The script is
 * passed as an encoded command, because the default execution policy does
 * not run script files. PowerShell is named by its full path and gets only
 * the variables it needs, the name of the credential among them.
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {Command}
 */
export function windowsCommand(name, env) {
  const root = env.SystemRoot ?? "C:\\Windows";
  // The same text whatever line endings the checkout gave the file.
  const script = readFileSync(
    new URL("./readCredential.ps1", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  return {
    file: path.win32.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env: {
      SystemRoot: root,
      TEMP: env.TEMP ?? path.win32.join(root, "Temp"),
      PUBLISH_POST_CREDENTIAL: name,
    },
  };
}

/** The exit code of `readCredential.ps1` when the store has no such entry. */
const WINDOWS_NOT_FOUND = 3;

async function readWindows(name, { env, runProcess: run }) {
  const { code, stdout } = await run(windowsCommand(name, env));
  if (code === WINDOWS_NOT_FOUND)
    throw unavailable(
      `The Windows credential store has no generic credential named "${name}".`,
    );
  if (code !== 0)
    throw unavailable(
      `Reading the Windows credential store failed (PowerShell exit code ${code}).`,
    );
  try {
    const { clientId, clientSecret } = JSON.parse(
      Buffer.from(stdout.trim(), "base64").toString("utf8"),
    );
    if (typeof clientId === "string" && typeof clientSecret === "string")
      return { clientId, clientSecret };
  } catch {
    // Reported below; the output may hold the secret and is never quoted.
  }
  throw unavailable("The answer of the credential store could not be read.");
}

const SECURITY = "/usr/bin/security";
/** The exit code of `security` when the Keychain has no such item. */
const KEYCHAIN_NOT_FOUND = 44;

/**
 * macOS: a generic password of the Keychain whose service is the name, whose
 * account is the Client ID and whose password is the Client Secret. The
 * account is read first, without the password; an item whose account is not
 * a Client ID is refused before its password is read.
 */
async function readKeychain(name, { runProcess: run }) {
  const security = async (...options) => {
    const { code, stdout } = await run({
      file: SECURITY,
      args: ["find-generic-password", "-s", name, ...options],
      env: {},
    });
    if (code === KEYCHAIN_NOT_FOUND)
      throw unavailable(
        `The macOS Keychain has no generic password with the service name "${name}".`,
      );
    if (code !== 0)
      throw unavailable(
        `Reading the macOS Keychain failed (security exit code ${code}).`,
      );
    return stdout;
  };

  const clientId = (await security()).match(
    /^\s*"acct"<blob>="(.+)"\s*$/m,
  )?.[1];
  if (!clientId || !SERVICE_CLIENT_ID.test(clientId))
    throw unavailable(
      `The account of the Keychain item "${name}" is not a service token Client ID. Its password was not read.`,
    );
  // `security` ends the password with a line break of its own.
  const clientSecret = (await security("-a", clientId, "-w")).replace(
    /\r?\n$/,
    "",
  );
  return { clientId, clientSecret };
}

const STORES = { win32: readWindows, darwin: readKeychain };

/**
 * Refuses a pair that cannot be a service token, without repeating its
 * values. A secret is also what every output is searched for, so one of a
 * few characters would shred the report instead of protecting it.
 * @param {ServiceToken} token
 * @param {string} source where the pair came from, for the message
 */
function check(token, source) {
  if (!SERVICE_CLIENT_ID.test(token.clientId))
    throw new ScriptError(
      "invalid-credentials",
      `The Client ID from ${source} is not a service token Client ID (32 hexadecimal characters and ".access").`,
    );
  if (!/^[\x21-\x7e]{32,}$/.test(token.clientSecret))
    throw new ScriptError(
      "invalid-credentials",
      `The Client Secret from ${source} is not a service token secret: it is shorter than 32 characters or holds spaces or characters a header cannot carry.`,
    );
  return token;
}

/**
 * The service token of a run: the environment first, then the named entry of
 * the system's credential store.
 * @param {object} deps
 * @param {Record<string, string | undefined>} deps.env
 * @param {string} deps.platform
 * @param {typeof runProcess} deps.runProcess
 * @param {string} [credential] the name given with `--credential`
 * @returns {Promise<ServiceToken>}
 */
export async function readServiceToken(deps, credential) {
  const clientId = deps.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = deps.env.CF_ACCESS_CLIENT_SECRET;
  if (clientId && clientSecret)
    return check({ clientId, clientSecret }, "the environment");

  if (!credential)
    throw new ScriptError(
      "missing-credentials",
      "Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or pass --credential <name> on Windows or macOS.",
    );
  const read = Object.hasOwn(STORES, deps.platform)
    ? STORES[deps.platform]
    : undefined;
  if (!read)
    throw unavailable(
      "--credential reads the Windows credential store or the macOS Keychain. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
    );
  return check(await read(credential, deps), `the credential "${credential}"`);
}
