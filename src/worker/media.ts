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
    return error("Niedozwolona metoda.", 405);
  }
  const object = await env.MEDIA.get(imageKey(mediaId));
  if (!object) {
    return error("Nie znaleziono grafiki.", 404);
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

function validPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 24 ||
    pngSignature.some((byte, index) => bytes[index] !== byte)
  ) {
    return false;
  }
  if (new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") {
    return false;
  }

  const dimensions = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  return [dimensions.getUint32(16), dimensions.getUint32(20)].every(
    (size) => size >= 1 && size <= MAX_IMAGE_DIMENSION,
  );
}

export async function uploadMedia(
  request: Request,
  env: Env,
  operator: Operator,
): Promise<Response> {
  if (request.headers.get("Content-Type") !== "image/png") {
    return error("Wybierz grafikę PNG.", 415);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request, MAX_IMAGE_BYTES);
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      const maxMb = MAX_IMAGE_BYTES / 1024 / 1024;
      return error(`Grafika musi mieć maksymalnie ${maxMb} MB.`, 413);
    }
    return error("Nie przesłano grafiki.", 400);
  }

  if (!validPng(bytes)) {
    return error(
      `Nieprawidłowy plik PNG (wymiary 1–${MAX_IMAGE_DIMENSION} px).`,
      400,
    );
  }

  const mediaId = crypto.randomUUID();
  await env.MEDIA.put(imageKey(mediaId), bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { owner: operator.subject },
  });
  return json({ mediaId });
}
