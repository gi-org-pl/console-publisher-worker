import { SERVICE_CLIENT_ID } from "../../src/schemas/publishing.ts";
import { ClientError } from "./errors.mjs";
import { readKeychain } from "./macosKeychain.mjs";
import { readWindowsCredential } from "./windowsCredential.mjs";

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

/** The credential store of each system that has one this client can read. */
const STORES = { win32: readWindowsCredential, darwin: readKeychain };

/**
 * The credentials of a run: the environment first, then the store named with
 * `--credential`.
 * @param {{ credential?: string }} options
 * @param {{ env: Record<string, string | undefined>, platform: string, runProcess: Function }} deps
 * @returns {Promise<Credentials>}
 */
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
      `Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET${set.length === 1 ? ` (only ${set[0]} is set)` : ""}, or pass --credential <name> on Windows or macOS.`,
    );
  }
  const read = Object.hasOwn(STORES, deps.platform)
    ? STORES[deps.platform]
    : undefined;
  if (!read)
    throw new ClientError(
      "credential-unavailable",
      "--credential reads the Windows credential store or the macOS Keychain. On this system set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
    );
  return checkCredentials(
    await read(options.credential, deps),
    `the credential "${options.credential}"`,
  );
}
