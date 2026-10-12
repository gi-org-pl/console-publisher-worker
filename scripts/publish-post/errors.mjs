// What the client reports instead of a stack trace.

/** A failure the caller reports in the JSON document under `errors`. */
export class ClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.status = status;
  }
}

export const CHECK_BUFFER =
  "The post may exist. Look in Buffer; this channel is not sent again with this state file.";
