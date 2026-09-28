import { endpoints } from "./api";
import { authenticate } from "./auth";
import { error } from "./http";
import { logError } from "./log";
import { mediaIdFromPath, serveMedia } from "./media";
import type { Env, Operator } from "./types";

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN) {
    return error("Nieprawidłowy adres usługi.", 403);
  }

  // Buffer fetches PNGs without an Access cookie. No other resource is public.
  const mediaId = mediaIdFromPath(url.pathname);
  if (mediaId) {
    return serveMedia(request, env, mediaId);
  }

  const endpoint = endpoints[url.pathname];
  if (!endpoint) {
    return error("Nie znaleziono endpointu.", 404);
  }

  let operator: Operator;
  try {
    operator = await authenticate(
      request,
      env.ACCESS_TEAM_DOMAIN,
      env.ACCESS_AUD,
    );
  } catch (cause) {
    logError("access-denied", cause, { path: url.pathname });
    return error("Zaloguj się przez Cloudflare Access.", 401);
  }

  if (request.method !== endpoint.method) {
    return error("Niedozwolona metoda.", 405);
  }

  if (endpoint.method === "POST") {
    if (request.headers.get("Origin") !== env.APP_ORIGIN) {
      return error("Niedozwolone źródło żądania.", 403);
    }
    if (!env.BUFFER_API_KEY) {
      return error("Publikacja nie jest jeszcze skonfigurowana.", 503);
    }
  }

  return endpoint.handle({ request, url, env, operator });
}
