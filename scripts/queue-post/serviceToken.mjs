import { SERVICE_CLIENT_ID } from "../../src/schemas/publishing.ts";
import { readKeychain, readWindows } from "./credentialStores.mjs";
import { ScriptError, unavailable } from "./errors.mjs";

// The service token of a run: where it comes from, what it has to look
// like, and how it is kept out of every output.

/** @typedef {{ clientId: string, clientSecret: string }} ServiceToken */

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
 * @param {typeof import("./credentialStores.mjs").runProcess} deps.runProcess
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

/** Removes both values of the token from every string of a JSON value. */
export function redact(value, secrets) {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets),
        redact(item, secrets),
      ]),
    );
  return value;
}
