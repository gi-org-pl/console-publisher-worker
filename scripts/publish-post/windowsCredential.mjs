import { readFileSync } from "node:fs";
import { ClientError } from "./errors.mjs";

// The Windows credential store: a generic credential whose user name is the
// Client ID and whose password is the Client Secret.

/** @typedef {import("./credentials.mjs").Credentials} Credentials */

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
 * Reads the named credential.
 * @param {string} name
 * @param {{ runProcess: typeof import("./process.mjs").runProcess }} deps
 * @returns {Promise<Credentials>}
 */
export async function readWindowsCredential(name, deps) {
  const { code, stdout } = await deps.runProcess(credentialCommand(name));
  if (code === CREDENTIAL_NOT_FOUND)
    throw new ClientError(
      "credential-unavailable",
      `The Windows credential store has no generic credential named "${name}".`,
    );
  if (code !== 0)
    throw new ClientError(
      "credential-unavailable",
      `Reading the Windows credential store failed (PowerShell exit code ${code}).`,
    );
  return parseCredentialOutput(stdout);
}
