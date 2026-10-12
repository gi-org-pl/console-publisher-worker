// Reading text files: the job, the texts it names and the state.

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decodes a text file. Bytes that are not UTF-8 are an error: decoded
 * leniently they would turn into replacement characters and go out as text.
 */
export function decodeText(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error("the file is not valid UTF-8");
  }
}
