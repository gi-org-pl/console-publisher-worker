// Nothing the client prints or writes may carry the Client ID or the Client Secret.

/**
 * Removes the credentials from a text.
 * @param {string} text
 * @param {string[]} secrets
 */
export function redact(text, secrets) {
  let clean = text;
  for (const secret of secrets)
    if (secret) clean = clean.replaceAll(secret, "[redacted]");
  return clean;
}

/**
 * The logger of a run: every line is cleared of the secrets known by then.
 * The list may grow after the logger is made - the credentials of a run are
 * known only once they are read.
 * @param {(line: string) => void} write
 * @param {string[]} secrets
 * @returns {(line: string) => void}
 */
export function createLog(write, secrets) {
  return (line) => {
    try {
      write(redact(line, secrets));
    } catch {
      // A closed stderr must not change what is reported about a post.
    }
  };
}

/**
 * Removes the credentials from every string of a JSON value, keys included.
 * The output document and the state file both pass through here.
 * @template T
 * @param {T} value
 * @param {string[]} secrets
 * @returns {T}
 */
export function redactDeep(value, secrets) {
  if (typeof value === "string")
    return /** @type {T} */ (redact(value, secrets));
  if (Array.isArray(value))
    return /** @type {T} */ (value.map((item) => redactDeep(item, secrets)));
  if (value !== null && typeof value === "object")
    return /** @type {T} */ (
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key, secrets),
          redactDeep(item, secrets),
        ]),
      )
    );
  return value;
}
