import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { SERVICE_CLIENT_ID } from "../../src/schemas/publishing.ts";
import { ClientError } from "./errors.mjs";

// Where the service token comes from: the environment, or the credential
// store of the system. The caller puts both values into request headers and
// nowhere else.

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

/**
 * The process that reads a generic credential from the Windows credential
 * store. The name travels in the environment, never inside the script text.
 *
 * The script (`readCredential.ps1`, PowerShell with a declaration in C#) is
 * passed as an encoded command and not with `-File`: the default execution
 * policy of Windows does not run script files.
 * @param {string} name
 */
export function credentialCommand(name) {
  // The same text whatever line endings the checkout gave the file.
  const script = readFileSync(
    new URL("./readCredential.ps1", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  return {
    file: "powershell",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
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
export async function resolveCredentials(options, deps) {
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
