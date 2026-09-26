import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import Fastify from "fastify";
import { createGoogleLoginProvider } from "../apps/control-plane/src/adapters/google-application-auth.ts";
import { main } from "../apps/control-plane/src/main.ts";

// Only the external Google transport is replaced. main owns every identity and route.
const cert = readFileSync(process.env["PI_ORB_E2E_GOOGLE_CERT"] ?? "");
const google = Fastify({
  https: { cert, key: readFileSync(process.env["PI_ORB_E2E_GOOGLE_KEY"] ?? "") },
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const codes = new Map<string, { redirect: string; nonce: string; challenge: string }>();
let issuer = "";
google.get("/authorize", async (request, reply) => {
  const query = new URLSearchParams(request.url.split("?")[1]);
  const redirect = query.get("redirect_uri") ?? "";
  if (
    ![process.env["PI_ORB_APP_ORIGIN"], process.env["PI_ORB_HOSTING_ORIGIN"]].some(
      (origin) => redirect === `${origin}/auth/callback`,
    )
  )
    return reply.code(400).send();
  const code = randomUUID();
  codes.set(code, {
    redirect,
    nonce: query.get("nonce") ?? "",
    challenge: query.get("code_challenge") ?? "",
  });
  const target = new URL(redirect);
  target.searchParams.set("code", code);
  target.searchParams.set("state", query.get("state") ?? "");
  return reply.redirect(target.href);
});
google.get("/jwks", async () => ({
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }],
}));
google.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_request, body, done) => done(null, body),
);
google.post("/token", async (request, reply) => {
  const query = new URLSearchParams(String(request.body));
  const code = query.get("code") ?? "";
  const material = codes.get(code);
  codes.delete(code);
  if (
    !material ||
    query.get("redirect_uri") !== material.redirect ||
    createHash("sha256")
      .update(query.get("code_verifier") ?? "")
      .digest("base64url") !== material.challenge
  )
    return reply.code(400).send({ error: "invalid_grant" });
  const iat = Math.floor(Date.now() / 1000);
  const body = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: "client",
        sub: "full-main-alice",
        email: "alice@heyglide.com",
        email_verified: true,
        hd: "heyglide.com",
        nonce: material.nonce,
        iat,
        exp: iat + 3600,
      }),
    ).toString("base64url"),
  ].join(".");
  return {
    access_token: "unused",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`,
  };
});
await google.listen({ port: 0, host: "127.0.0.1" });
const address = google.server.address();
if (!address || typeof address === "string") throw new Error("Google listener missing");
issuer = `https://localhost:${address.port}`;
const agent = new Agent({
  ca: cert,
  lookup(_hostname, options, callback) {
    callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
  },
});
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
    customFetch: async (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const request = httpsRequest(
          new URL(String(input)),
          {
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            agent,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("error", reject);
            response.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 500,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          },
        );
        request.on("error", reject);
        request.end(init?.body ? String(init.body) : undefined);
      }),
  },
)._unsafeUnwrap();
await main({ googleLoginProvider: provider });
