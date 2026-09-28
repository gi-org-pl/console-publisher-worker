import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(
  request: Request,
  issuer: string,
  audience: string,
) {
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
    requiredClaims: ["exp", "sub", "email"],
  });
  if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
    throw new Error("Missing user identity");
  }

  return { email: payload.email, subject: payload.sub };
}
