import { z } from "zod";
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from "../schemas/publishing";
import { BodyTooLargeError, error, json, readLimited } from "./http";
import type { Env, Operator } from "./types";

const mediaPath = /^\/buffer-media\/([0-9a-f-]{36})\.png$/;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

export function imageKey(mediaId: string): string {
  return `images/${mediaId}`;
}

/** The public URL Buffer fetches; `mediaIdFromPath` parses it back. */
export function mediaUrl(env: Env, mediaId: string): string {
  return `${env.APP_ORIGIN}/buffer-media/${mediaId}.png`;
}

export function mediaIdFromPath(pathname: string): string | undefined {
  const candidate = mediaPath.exec(pathname)?.[1];
  return candidate && z.uuid().safeParse(candidate).success
    ? candidate
    : undefined;
}

export async function serveMedia(
  request: Request,
  env: Env,
  mediaId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error("Method not allowed.", 405);
  }
  const object = await env.MEDIA.get(imageKey(mediaId));
  if (!object) {
    return error("Image not found.", 404);
  }
  return new Response(
    request.method === "HEAD" ? null : (object.body as ReadableStream),
    {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** The width and height of a valid PNG, or undefined for anything else. */
function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (
    bytes.length < 24 ||
    pngSignature.some((byte, index) => bytes[index] !== byte)
  ) {
    return undefined;
  }
  if (new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") {
    return undefined;
  }

  const dimensions = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  return [width, height].every(
    (size) => size >= 1 && size <= MAX_IMAGE_DIMENSION,
  )
    ? { width, height }
    : undefined;
}

/**
 * Landscape or square, from the size recorded at upload. An image uploaded
 * before the size was recorded counts as neither.
 */
export function landscapeOrSquare(metadata?: Record<string, string>): boolean {
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  return width > 0 && height > 0 && width >= height;
}

export async function uploadMedia(
  request: Request,
  env: Env,
  operator: Operator,
): Promise<Response> {
  if (request.headers.get("Content-Type") !== "image/png") {
    return error("Choose a PNG image.", 415);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request, MAX_IMAGE_BYTES);
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      const maxMb = MAX_IMAGE_BYTES / 1024 / 1024;
      return error(`The image must be at most ${maxMb} MB.`, 413);
    }
    return error("No image was uploaded.", 400);
  }

  const size = pngSize(bytes);
  if (!size) {
    return error(
      `Invalid PNG file (dimensions must be 1-${MAX_IMAGE_DIMENSION} px).`,
      400,
    );
  }

  const mediaId = crypto.randomUUID();
  await env.MEDIA.put(imageKey(mediaId), bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {
      owner: operator.subject,
      // Kept so an announcement can tell landscape from portrait without reading the image.
      width: String(size.width),
      height: String(size.height),
    },
  });
  return json({ mediaId });
}
