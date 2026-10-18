import type { ReadableStream as R2Stream } from "@cloudflare/workers-types";
import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_VIDEO_BYTES,
} from "../schemas/publishing";
import { BodyTooLargeError, error, json, readLimited } from "./http";
import { logEvent } from "./log";
import type { Env, Operator } from "./types";

const mediaPath = /^\/buffer-media\/([0-9a-f-]{36})\.(png|mp4)$/;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
/** The bytes an MP4 has to start with: an ISO BMFF `ftyp` box with its major brand and version. */
const FTYP_BOX_BYTES = 16;

export type MediaKind = "image" | "video";

export function imageKey(mediaId: string): string {
  return `images/${mediaId}`;
}

/**
 * Under `images/` as well, so the lifecycle rule that deletes images after 90
 * days deletes videos too; the suffix keeps the two apart.
 */
export function videoKey(mediaId: string): string {
  return `images/${mediaId}.mp4`;
}

/** The public URL Buffer fetches; `mediaFromPath` parses it back. */
export function mediaUrl(env: Env, mediaId: string): string {
  return `${env.APP_ORIGIN}/buffer-media/${mediaId}.png`;
}

export function videoUrl(env: Env, mediaId: string): string {
  return `${env.APP_ORIGIN}/buffer-media/${mediaId}.mp4`;
}

export function mediaFromPath(
  pathname: string,
): { mediaId: string; kind: MediaKind } | undefined {
  const match = mediaPath.exec(pathname);
  if (!match || !z.uuid().safeParse(match[1]).success) {
    return undefined;
  }
  return { mediaId: match[1], kind: match[2] === "mp4" ? "video" : "image" };
}

const mediaHeaders = {
  "Cache-Control": "public, max-age=3600",
  "X-Content-Type-Options": "nosniff",
};

export async function serveMedia(
  request: Request,
  env: Env,
  { mediaId, kind }: { mediaId: string; kind: MediaKind },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error("Method not allowed.", 405);
  }
  if (kind === "video") {
    const response = await serveVideo(request, env, mediaId);
    // Whether Buffer or a network fetches a video in ranges is not
    // documented; one line per fetch shows it on the first real posts.
    logEvent("video-served", {
      mediaId,
      method: request.method,
      range: request.headers.get("Range")?.slice(0, 100) ?? null,
      status: response.status,
    });
    return response;
  }
  const object = await env.MEDIA.get(imageKey(mediaId));
  if (!object) {
    return error("Image not found.", 404);
  }
  return new Response(
    request.method === "HEAD" ? null : (object.body as ReadableStream),
    { headers: { "Content-Type": "image/png", ...mediaHeaders } },
  );
}

/**
 * The one range of a `Range` header, within a file of `size` bytes. Undefined
 * means the whole file: no header, or one this does not take (several ranges,
 * another unit), which HTTP allows a server to ignore.
 */
export function byteRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | "unsatisfiable" | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) {
    return undefined;
  }
  if (match[1] === "") {
    // The last n bytes.
    const suffix = Number(match[2]);
    return suffix === 0
      ? "unsatisfiable"
      : { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || end < start
    ? "unsatisfiable"
    : { offset: start, length: end - start + 1 };
}

/**
 * A video is served with its length and in parts on request: a network that
 * fetches a video may ask for it in ranges.
 */
async function serveVideo(
  request: Request,
  env: Env,
  mediaId: string,
): Promise<Response> {
  const key = videoKey(mediaId);
  const head = await env.MEDIA.head(key);
  if (!head) {
    return error("Video not found.", 404);
  }
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    ...mediaHeaders,
  };
  if (request.method === "HEAD") {
    return new Response(null, {
      headers: { ...headers, "Content-Length": String(head.size) },
    });
  }

  const range = byteRange(request.headers.get("Range"), head.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${head.size}` },
    });
  }
  const object = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!object || !("body" in object)) {
    return error("Video not found.", 404);
  }
  if (!range) {
    return new Response(object.body as ReadableStream, {
      headers: { ...headers, "Content-Length": String(head.size) },
    });
  }
  const last = range.offset + range.length - 1;
  return new Response(object.body as ReadableStream, {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(range.length),
      "Content-Range": `bytes ${range.offset}-${last}/${head.size}`,
    },
  });
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
 * Whether a file starts like an MP4: an ISO BMFF `ftyp` box of at least 16
 * bytes that fits in the file. Codecs, length and size of the picture are the
 * network's to check.
 */
export function isMp4(start: Uint8Array, fileSize: number): boolean {
  if (start.length < FTYP_BOX_BYTES) {
    return false;
  }
  const boxSize = new DataView(
    start.buffer,
    start.byteOffset,
    start.byteLength,
  ).getUint32(0);
  return (
    new TextDecoder().decode(start.slice(4, 8)) === "ftyp" &&
    boxSize >= FTYP_BOX_BYTES &&
    boxSize <= fileSize
  );
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
  const contentType = request.headers.get("Content-Type");
  if (contentType === "video/mp4") {
    return uploadVideo(request, env, operator);
  }
  if (contentType !== "image/png") {
    return error("Choose a PNG image or an MP4 video.", 415);
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

/**
 * A video is streamed into R2 instead of being read into memory: 100 MB would
 * not fit beside the Worker's other work. R2 takes a stream only with a known
 * length, so the request has to declare it; the platform holds the body to
 * that length. The start of the file is checked once it is stored, and a file
 * that is no MP4 is deleted before anyone learns its ID.
 */
async function uploadVideo(
  request: Request,
  env: Env,
  operator: Operator,
): Promise<Response> {
  const declared = request.headers.get("Content-Length");
  const length = Number(declared);
  const maxMb = MAX_VIDEO_BYTES / 1024 / 1024;
  if (declared === null || !Number.isSafeInteger(length)) {
    return error("Send the video with its length (Content-Length).", 411);
  }
  if (length > MAX_VIDEO_BYTES) {
    return error(`The video must be at most ${maxMb} MB.`, 413);
  }
  if (length < FTYP_BOX_BYTES || !request.body) {
    return error("Invalid MP4 file.", 400);
  }

  const mediaId = crypto.randomUUID();
  const key = videoKey(mediaId);
  // The DOM and the Workers types name the same stream twice.
  await env.MEDIA.put(key, request.body as unknown as R2Stream, {
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: { owner: operator.subject },
  });
  const start = await env.MEDIA.get(key, {
    range: { offset: 0, length: FTYP_BOX_BYTES },
  });
  const bytes = start
    ? new Uint8Array(await start.arrayBuffer())
    : new Uint8Array();
  if (!isMp4(bytes, start?.size ?? 0)) {
    await env.MEDIA.delete(key);
    return error("Invalid MP4 file.", 400);
  }
  return json({ mediaId });
}
