export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function error(message: string, status: number): Response {
  return json({ message }, status);
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Body too large");
    this.name = "BodyTooLargeError";
  }
}

/** Enforce limits while reading, since a client can omit or lie about Content-Length. */
export async function readLimited(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length")) > limit) {
    throw new BodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Missing body");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  return concat(chunks, length);
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
