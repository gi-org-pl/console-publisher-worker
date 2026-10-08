import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { SERVICE_CLIENT_ID } from "../schemas/publishing";
import type { Identity } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Access signs one kind of application token for both a person and a service
 * token. A person has `email` and a non-empty `sub`; a service token has an
 * empty `sub`, no `email`, and its Client ID in `common_name`. Anything that
 * matches neither shape exactly is refused.
 */
function identify(payload: JWTPayload): Identity {
  const { sub, email, common_name: clientId } = payload;

  if (clientId === undefined) {
    if (typeof email !== "string" || typeof sub !== "string" || !sub) {
      throw new Error("Missing user identity");
    }
    return { kind: "user", email, subject: sub };
  }

  if (
    typeof clientId !== "string" ||
    !SERVICE_CLIENT_ID.test(clientId) ||
    sub !== "" ||
    email !== undefined ||
    payload.type !== "app"
  ) {
    throw new Error("Unexpected service token claims");
  }
  return { kind: "service", clientId };
}

/** Proves who Access let through. Whether a service may act is decided by the caller. */
export async function authenticate(
  request: Request,
  issuer: string,
  audience: string,
): Promise<Identity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (
    !token ||
    !audience ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
  ) {
    throw new Error("Missing Access configuration or token");
  }

  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }

  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub"],
  });
  return identify(payload);
}
