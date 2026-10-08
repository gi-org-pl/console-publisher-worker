// @vitest-environment node
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth";

const issuer = "https://test.cloudflareaccess.com";
const clientId = "e367826f93b8d71185e03fe518aff3b4.access";
/** The service token payload from the Cloudflare Access application token reference. */
const serviceClaims = { type: "app", common_name: clientId, sub: "" };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }],
      }),
    ),
  );
});
afterAll(() => vi.unstubAllGlobals());
async function sign(
  claims: Record<string, unknown>,
  overrides: { audience?: string; expires?: string; issuer?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "app-aud")
    .setExpirationTime(overrides.expires ?? "5m")
    .sign(keys.privateKey);
}
async function token(
  overrides: {
    audience?: string;
    expires?: string;
    issuer?: string;
    email?: unknown;
    sub?: unknown;
  } = {},
) {
  return sign(
    {
      type: "app",
      email: overrides.email ?? "operator@example.org",
      sub: overrides.sub ?? "operator",
    },
    overrides,
  );
}
function request(jwt: string) {
  return new Request("https://publish.example.org", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
}
describe("Given Cloudflare Access JWT authentication", () => {
  it("accepts a valid signature, issuer, audience and identity", async () => {
    expect(
      await authenticate(request(await token()), issuer, "app-aud"),
    ).toEqual({
      kind: "user",
      email: "operator@example.org",
      subject: "operator",
    });
  });
  it.each([
    { audience: "other" },
    { expires: "-5m" },
    { issuer: "https://evil.example" },
    { email: 123 },
    { sub: "" },
    { sub: 123 },
  ])("rejects invalid claims: %j", async (claims) => {
    await expect(
      authenticate(request(await token(claims)), issuer, "app-aud"),
    ).rejects.toThrow();
  });
  it("rejects a token with neither an email nor a service identity", async () => {
    await expect(
      authenticate(
        request(await sign({ type: "app", sub: "operator" })),
        issuer,
        "app-aud",
      ),
    ).rejects.toThrow("Missing user identity");
    await expect(
      authenticate(request(await sign({ type: "app" })), issuer, "app-aud"),
    ).rejects.toThrow();
  });
  it("rejects a forged token and missing configuration", async () => {
    await expect(
      authenticate(request("forged"), issuer, "app-aud"),
    ).rejects.toThrow();
    await expect(
      authenticate(request(""), issuer, "app-aud"),
    ).rejects.toThrow();
    await expect(
      authenticate(request(await token()), "https://evil.example", "app-aud"),
    ).rejects.toThrow();
    await expect(
      authenticate(request(await token()), issuer, ""),
    ).rejects.toThrow();
  });
});

describe("Given a Cloudflare Access service token JWT", () => {
  it("returns the Client ID as the service identity", async () => {
    expect(
      await authenticate(request(await sign(serviceClaims)), issuer, "app-aud"),
    ).toEqual({ kind: "service", clientId });
  });
  it.each([
    { audience: "other" },
    { expires: "-5m" },
    { issuer: "https://evil.example" },
  ])("verifies the same signature checks as for a person: %j", async (overrides) => {
    await expect(
      authenticate(
        request(await sign(serviceClaims, overrides)),
        issuer,
        "app-aud",
      ),
    ).rejects.toThrow();
  });
  it.each([
    { common_name: 123 },
    { common_name: "" },
    { common_name: "gieniek-bot" },
    { common_name: `${clientId}.evil` },
    { sub: "operator" },
    { sub: undefined },
    { email: "operator@example.org" },
    { type: "org" },
    { type: undefined },
  ])("rejects claims outside the documented shape: %j", async (claims) => {
    await expect(
      authenticate(
        request(await sign({ ...serviceClaims, ...claims })),
        issuer,
        "app-aud",
      ),
    ).rejects.toThrow();
  });
});
