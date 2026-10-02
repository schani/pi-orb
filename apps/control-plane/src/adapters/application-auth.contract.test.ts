import { generateKeyPairSync, sign } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admittedGoogleIdentity,
  createGoogleLoginProvider,
  createGoogleMachineVerifier,
  GOOGLE_ISSUER,
} from "./google-application-auth.ts";
import { createSealedAuthCookies } from "./sealed-auth-cookies.ts";

const key = "restart-stable-cookie-key-not-workload-signing-key";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("maintained auth library contracts", () => {
  it("seals confidentially, survives restart, rejects tampering and key replacement", async () => {
    const first = createSealedAuthCookies(key)._unsafeUnwrap();
    const second = createSealedAuthCookies(key)._unsafeUnwrap();
    const value = {
      purpose: "session",
      user: { id: "private-uuid", email: null },
      origin: "https://app.example",
      expiresAt: 123,
    };
    const sealed = (await first.seal(value))._unsafeUnwrap();
    expect(sealed).not.toContain("private-uuid");
    expect((await second.unseal(sealed))._unsafeUnwrap()).toEqual(value);
    expect((await second.unseal(`${sealed}x`)).isErr()).toBe(true);
    expect(
      (await createSealedAuthCookies(`${key}replacement`)._unsafeUnwrap().unseal(sealed)).isErr(),
    ).toBe(true);
    expect(createSealedAuthCookies("short").isErr()).toBe(true);
  });
  it("company admission uses verified claims, never email linking", () => {
    const claims = {
      iss: GOOGLE_ISSUER,
      aud: "client",
      sub: "immutable",
      exp: 100,
      email: "a@heyglide.com",
      email_verified: true,
      hd: "heyglide.com",
    };
    expect(admittedGoogleIdentity(claims, "client", 0)._unsafeUnwrap().subject).toBe("immutable");
    for (const change of [
      { iss: "https://evil.example" },
      { aud: "wrong" },
      { exp: 0 },
      { sub: "" },
      { email_verified: false },
      { hd: "evil.example" },
    ]) {
      expect(admittedGoogleIdentity({ ...claims, ...change }, "client", 0).isErr()).toBe(true);
    }
  });
  it("Google authorization URL contains PKCE, nonce, state and fixed issuer", async () => {
    const provider = createGoogleLoginProvider({
      clientId: "client",
      clientSecret: "secret",
    })._unsafeUnwrap();
    const { NoSimulationTask } = await import("determined");
    const material = (
      await provider.start(
        new NoSimulationTask("google login", false),
        "https://app.example/auth/callback",
      )
    )._unsafeUnwrap();
    const url = new URL(material.authorizationUrl);
    expect(url.origin).toBe(GOOGLE_ISSUER);
    expect(url.searchParams.get("state")).toBe(material.state);
    expect(url.searchParams.get("nonce")).toBe(material.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(material.codeVerifier);
  });
  it("reports key-provider outages without leaking the provider error", async () => {
    vi.spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync").mockRejectedValue(
      new Error("secret-provider-detail"),
    );
    const result = await createGoogleMachineVerifier({ audience: "aud", subject: "sub" }).verify(
      `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "key" })).toString("base64url")}.body.signature`,
    );
    expect(result.isErr() && result.error.type).toBe("identity_unavailable");
    expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
  });
  it("verifies signed Google machine tokens with exact audience and immutable subject", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certs = { test: publicKey.export({ type: "spki", format: "pem" }).toString() };
    vi.spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync").mockResolvedValue({
      certs,
      format: "PEM",
    } as Awaited<ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>>);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const now = Date.now();
    const claims = {
      iss: GOOGLE_ISSUER,
      aud: "exact-audience",
      sub: "123456",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
    };
    const jwt = (changes = {}) => {
      const body = [
        Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
        Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url"),
      ].join(".");
      return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
    };
    const verifier = createGoogleMachineVerifier({
      audience: "exact-audience",
      subject: "123456",
      now: () => now,
    });
    expect((await verifier.verify(jwt()))._unsafeUnwrap()).toEqual({ kind: "ops", id: "123456" });
    for (const change of [
      { aud: "wrong" },
      { aud: ["exact-audience", "other"] },
      { sub: "email@example.com" },
      { iss: "evil" },
      { exp: Math.floor(now / 1000) },
      { iat: Math.floor(now / 1000) + 600 },
      { nbf: Math.floor(now / 1000) + 600 },
    ])
      expect((await verifier.verify(jwt(change))).isErr()).toBe(true);
    expect((await verifier.verify(`${jwt()}tamper`)).isErr()).toBe(true);
  });
});
