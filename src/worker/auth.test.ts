// @vitest-environment node
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth";

const issuer = "https://test.cloudflareaccess.com";
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
async function token(
  overrides: {
    audience?: string;
    expires?: string;
    issuer?: string;
    email?: unknown;
  } = {},
) {
  return new SignJWT({ email: overrides.email ?? "operator@example.org" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("operator")
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "app-aud")
    .setExpirationTime(overrides.expires ?? "5m")
    .sign(keys.privateKey);
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
    ).toEqual({ email: "operator@example.org", subject: "operator" });
  });
  it.each([
    { audience: "other" },
    { expires: "-5m" },
    { issuer: "https://evil.example" },
    { email: 123 },
  ])("rejects invalid claims: %j", async (claims) => {
    await expect(
      authenticate(request(await token(claims)), issuer, "app-aud"),
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
