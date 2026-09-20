import { generateKeyPairSync, sign } from "node:crypto";
import { NoSimulationTask } from "determined";
import { afterEach, expect, it, vi } from "vitest";
import { createGoogleLoginProvider } from "./google-application-auth.ts";

afterEach(() => vi.useRealTimers());

it("real OIDC validates signed code exchange, nonce, PKCE and single-use code", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://google.test";
  let nonce = "";
  let consumed = false;
  let exchanges = 0;
  let expectedVerifier = "";
  let claimOverrides: Record<string, unknown> = {};
  const provider = createGoogleLoginProvider(
    { clientId: "client", clientSecret: "secret" },
    {
      metadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      },
      customFetch: async (url, options) => {
        if (String(url) === `${issuer}/jwks`)
          return Response.json({
            keys: [
              { ...publicKey.export({ format: "jwk" }), kid: "key", alg: "RS256", use: "sig" },
            ],
          });
        expect(String(url)).toBe(`${issuer}/token`);
        exchanges++;
        const body = new URLSearchParams(String(options.body));
        expect(body.get("code_verifier")).toBe(expectedVerifier);
        expect(body.get("redirect_uri")).toBe("https://app.test/auth/callback");
        if (consumed) return Response.json({ error: "invalid_grant" }, { status: 400 });
        consumed = true;
        const now = Math.floor(Date.now() / 1000);
        const signingInput = [
          Buffer.from(JSON.stringify({ alg: "RS256", kid: "key" })).toString("base64url"),
          Buffer.from(
            JSON.stringify({
              iss: issuer,
              aud: "client",
              sub: "google-user",
              iat: now,
              exp: now + 300,
              nonce,
              email: "user@heyglide.com",
              email_verified: true,
              hd: "heyglide.com",
              ...claimOverrides,
            }),
          ).toString("base64url"),
        ].join(".");
        const idToken = `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
        return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
      },
    },
  )._unsafeUnwrap();
  const task = new NoSimulationTask("signed oidc", false);
  const material = (await provider.start(task, "https://app.test/auth/callback"))._unsafeUnwrap();
  nonce = material.nonce;
  expectedVerifier = material.codeVerifier;
  const callback = `https://app.test/auth/callback?code=one&state=${material.state}`;
  const wrongState = await provider.complete(
    task,
    callback.replace(material.state, "wrong"),
    material,
  );
  expect(wrongState.isErr()).toBe(true);
  expect(exchanges).toBe(0);
  const success = await provider.complete(task, callback, material);
  expect(success.isOk(), JSON.stringify(success)).toBe(true);
  expect(success._unsafeUnwrap()).toEqual({
    issuer,
    subject: "google-user",
    email: "user@heyglide.com",
  });
  expect((await provider.complete(task, callback, material)).isErr()).toBe(true);
  expect(exchanges).toBe(2);
  for (const claims of [
    { exp: Math.floor(Date.now() / 1000) - 600 },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    consumed = false;
    claimOverrides = claims;
    const result = await provider.complete(task, callback, material);
    expect(result.isErr() && result.error.type).toBe("unauthenticated");
  }
  claimOverrides = {};
  consumed = false;
  nonce = "wrong-nonce";
  expect(
    (await provider.complete(task, callback.replace("code=one", "code=two"), material)).isErr(),
  ).toBe(true);
});

for (const source of ["authorization", "token"] as const) {
  for (const code of [
    "server_error",
    "temporarily_unavailable",
    "invalid_client",
    "invalid_grant",
    "access_denied",
  ]) {
    it(`sanitizes ${source} ${code} without retrying exchange`, async () => {
      let exchanges = 0;
      const provider = createGoogleLoginProvider(
        { clientId: "client", clientSecret: "secret" },
        {
          customFetch: async () => {
            exchanges++;
            return Response.json(
              { error: code, error_description: "secret-detail" },
              { status: 400 },
            );
          },
        },
      )._unsafeUnwrap();
      const task = new NoSimulationTask("provider error", false);
      const material = (
        await provider.start(task, "https://app.test/auth/callback")
      )._unsafeUnwrap();
      const query =
        source === "authorization" ? `error=${code}&error_description=secret-detail` : "code=once";
      const result = await provider.complete(
        task,
        `https://app.test/auth/callback?${query}&state=${material.state}`,
        material,
      );
      expect(result.isErr() && result.error.type).toBe(
        ["invalid_grant", "access_denied"].includes(code)
          ? "unauthenticated"
          : "identity_unavailable",
      );
      expect(JSON.stringify(result)).not.toContain("secret-detail");
      expect(exchanges).toBe(source === "authorization" ? 0 : 1);
    });
  }
}
