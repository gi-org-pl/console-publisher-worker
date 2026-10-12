import { SERVICE_CLIENT_ID } from "../../src/schemas/publishing.ts";
import { ClientError } from "./errors.mjs";

// The macOS Keychain: a generic password whose service name is the name given
// to `--credential`, whose account is the Client ID and whose password is the
// Client Secret. It is read with the system's own `security`.

/** @typedef {import("./credentials.mjs").Credentials} Credentials */

/** By its full path, so nothing on PATH can stand in for it. */
const SECURITY = "/usr/bin/security";

/** The exit code of `security` when the Keychain has no such item. */
export const KEYCHAIN_ITEM_NOT_FOUND = 44;

/**
 * The process that prints the attributes of the item, the account among
 * them. This one prints no secret.
 * @param {string} name
 */
export function keychainAccountCommand(name) {
  return {
    file: SECURITY,
    args: ["find-generic-password", "-s", name],
    env: {},
  };
}

/**
 * The process that prints the password of the item and nothing else. The
 * account is named too, so it is the password of the item whose account was
 * read, also when two items share a service name.
 * @param {string} name
 * @param {string} account
 */
export function keychainSecretCommand(name, account) {
  return {
    file: SECURITY,
    args: ["find-generic-password", "-s", name, "-a", account, "-w"],
    env: {},
  };
}

/**
 * The account in the attributes `security` printed: the line
 * `"acct"<blob>="..."`. An item without an account has `<NULL>` there, and a
 * name that is not plain text is printed in hexadecimal; neither is a
 * Client ID.
 * @param {string} stdout
 * @returns {string | undefined}
 */
export function parseKeychainAccount(stdout) {
  return stdout.match(/^\s*"acct"<blob>="(.+)"\s*$/m)?.[1];
}

/**
 * Reads the named item.
 * @param {string} name
 * @param {{ runProcess: typeof import("./process.mjs").runProcess }} deps
 * @returns {Promise<Credentials>}
 */
export async function readKeychain(name, deps) {
  const run = async (command) => {
    const { code, stdout } = await deps.runProcess(command);
    if (code === KEYCHAIN_ITEM_NOT_FOUND)
      throw new ClientError(
        "credential-unavailable",
        `The macOS Keychain has no generic password with the service name "${name}".`,
      );
    if (code !== 0)
      throw new ClientError(
        "credential-unavailable",
        `Reading the macOS Keychain failed (security exit code ${code}).`,
      );
    return stdout;
  };

  const clientId = parseKeychainAccount(
    await run(keychainAccountCommand(name)),
  );
  if (clientId === undefined)
    throw new ClientError(
      "credential-unavailable",
      `The Keychain item "${name}" has no account that can be read. Its account has to be the Client ID.`,
    );
  // The password of an item that is not a service token is none of this
  // client's business: such an item is refused before its password is read.
  if (!SERVICE_CLIENT_ID.test(clientId))
    throw new ClientError(
      "invalid-credentials",
      `The account of the Keychain item "${name}" is not a service token Client ID (32 hexadecimal characters and ".access"). Its password was not read.`,
    );
  const secret = await run(keychainSecretCommand(name, clientId));
  // `security` ends the password with a line break of its own.
  return { clientId, clientSecret: secret.replace(/\r?\n$/, "") };
}
