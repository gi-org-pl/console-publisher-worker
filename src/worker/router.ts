import { endpoints } from "./api";
import { authenticate } from "./auth";
import { loadServices } from "./config";
import { error } from "./http";
import { logError } from "./log";
import { mediaIdFromPath, serveMedia } from "./media";
import type { Env, Identity, Operator } from "./types";

/** A person is already vetted by the Access policy; a service must also be allowlisted here. */
function toOperator(identity: Identity, env: Env): Operator | undefined {
  if (identity.kind === "user") {
    return identity;
  }

  const service = loadServices(env).find(
    (entry) => entry.clientId === identity.clientId,
  );
  return (
    service && {
      kind: "service",
      name: service.name,
      subject: `service:${service.clientId}`,
      minScheduleLeadMs: service.minScheduleLeadMinutes * 60_000,
      channelIds: service.channelIds,
    }
  );
}

/**
 * The Origin check is CSRF protection for the operator's browser cookie. A
 * service token is sent in explicit headers, so its client has no Origin; one
 * that does send it is held to the same rule.
 */
function originAllowed(request: Request, env: Env, operator: Operator) {
  const origin = request.headers.get("Origin");
  if (operator.kind === "service" && origin === null) {
    return true;
  }
  return origin === env.APP_ORIGIN;
}

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN) {
    return error("Invalid service address.", 403);
  }

  // Buffer fetches PNGs without an Access cookie. No other resource is public.
  const mediaId = mediaIdFromPath(url.pathname);
  if (mediaId) {
    return serveMedia(request, env, mediaId);
  }

  const endpoint = endpoints[url.pathname];
  if (!endpoint) {
    return error("Endpoint not found.", 404);
  }

  let identity: Identity;
  try {
    identity = await authenticate(
      request,
      env.ACCESS_TEAM_DOMAIN,
      env.ACCESS_AUD,
    );
  } catch (cause) {
    logError("access-denied", cause, { path: url.pathname });
    return error("Sign in via Cloudflare Access.", 401);
  }

  const operator = toOperator(identity, env);
  if (!operator) {
    logError("service-denied", new Error("Service token not allowlisted"), {
      path: url.pathname,
      ...identity,
    });
    return error("This service token is not allowed.", 403);
  }

  if (request.method !== endpoint.method) {
    return error("Method not allowed.", 405);
  }

  if (endpoint.method === "POST") {
    if (!originAllowed(request, env, operator)) {
      return error("Request origin not allowed.", 403);
    }
    if (!env.BUFFER_API_KEY) {
      return error("Publishing is not configured yet.", 503);
    }
  }

  return endpoint.handle({ request, url, env, operator });
}
