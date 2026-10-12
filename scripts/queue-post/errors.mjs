// What the script reports instead of a stack trace.

/** A failure the script reports instead of a stack trace. */
export class ScriptError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const invalidJob = (message) => new ScriptError("invalid-job", message);
export const unavailable = (message) =>
  new ScriptError("credential-unavailable", message);
