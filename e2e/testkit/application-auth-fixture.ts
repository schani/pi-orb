import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import websocket from "@fastify/websocket";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, ok, okAsync } from "neverthrow";
import { createGoogleLoginProvider } from "../../apps/control-plane/src/adapters/google-application-auth.ts";
import { createSealedAuthCookies } from "../../apps/control-plane/src/adapters/sealed-auth-cookies.ts";
import { createApplicationAuth } from "../../apps/control-plane/src/domain/application-auth.ts";
import {
  type AuthOutcomeSink,
  registerAuthRoutes,
} from "../../apps/control-plane/src/http/auth-routes.ts";
import { registerAuthenticatedBrowserRoutes } from "../../apps/control-plane/src/http/browser-identity.ts";
import {
  createHostingAccessPolicy,
  registerHostingAccessGuard,
} from "../../apps/control-plane/src/http/hosting-access.ts";
import { createGoogleRequestPrincipalResolver } from "../../apps/control-plane/src/identity-composition.ts";

import { startAuthConnectProxy } from "./auth-connect-proxy.ts";

/** Owned HTTPS origins; only user identity persistence is replaced, never login/session verification. */
export async function startApplicationAuthFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-orb-auth-"));
  const cleanup: (() => Promise<unknown>)[] = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  const close = async () => {
    const results = await Promise.allSettled(
      cleanup
        .splice(0)
        .reverse()
        .map((dispose) => dispose()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Auth fixture cleanup failed",
      );
  };
  try {
    const suffix = randomUUID();
    const appHost = `app.${suffix}.orb.test`;
    const filesHost = `files.${suffix}.orb.test`;
    const googleHost = `google.${suffix}.provider.test`;

    await writeFile(
      join(directory, "openssl.cnf"),
      `[req]\ndistinguished_name=dn\n[dn]\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:${appHost},DNS:${filesHost},DNS:${googleHost}\n`,
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-subj",
        "/CN=pi-orb-auth-test",
        "-config",
        join(directory, "openssl.cnf"),
        "-extensions",
        "v3",
      ],
      { stdio: "ignore" },
    );
    const tls = {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    };
    const google = Fastify({ https: tls, logger: false });
    const app = Fastify({ https: tls, logger: false });
    cleanup.push(
      () => google.close(),
      () => app.close(),
    );
    for (const server of [google.server, app.server]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const port = (server: typeof app.server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing owned listener");
      return address.port;
    };
    const appOrigin = `https://${appHost}:${port(app.server)}`;
    const filesOrigin = `https://${filesHost}:${port(app.server)}`;
    const issuer = `https://${googleHost}:${port(google.server)}`;
    const origins = { appOrigin, filesOrigin };
    const proxy = await startAuthConnectProxy(
      new Map([
        [new URL(appOrigin).host, port(app.server)],
        [new URL(filesOrigin).host, port(app.server)],
        [new URL(issuer).host, port(google.server)],
      ]),
    );
    cleanup.push(proxy.close);
    const providerAgent = new Agent({
      ca: tls.cert,
      lookup(hostname, options, callback) {
        if (hostname !== googleHost) {
          callback(new Error("Unowned provider hostname"), "", 4);
          return;
        }
        callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
      },
    });
    cleanup.push(async () => providerAgent.destroy());
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let company = "heyglide.com";
    let subject = "alice";
    const outcomes: Parameters<AuthOutcomeSink>[0][] = [];
    const authOutcome: AuthOutcomeSink = (event) => {
      outcomes.push(event);
    };
    let replaceState = false;
    let callback = "";
    let loginCookie = "";
    let exchanges = 0;
    let resolutions = 0;
    let mutations = 0;
    let now = Date.now();
    const codes = new Map<
      string,
      { redirect: string; nonce: string; challenge: string; company: string }
    >();
    google.get("/authorize", async (request, reply) => {
      const query = new URLSearchParams(request.url.split("?")[1]);
      const code = randomUUID();
      const redirect = query.get("redirect_uri") ?? "";
      if (![`${appOrigin}/auth/callback`, `${filesOrigin}/auth/callback`].includes(redirect))
        return reply.code(400).send();
      codes.set(code, {
        redirect,
        nonce: query.get("nonce") ?? "",
        challenge: query.get("code_challenge") ?? "",
        company,
      });
      const target = new URL(redirect);
      target.searchParams.set("code", code);
      target.searchParams.set("state", replaceState ? "wrong-state" : (query.get("state") ?? ""));
      callback = target.href;
      return reply.redirect(callback);
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
      exchanges++;
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
      const issuedAt = Math.floor(Date.now() / 1000);
      const body = [
        Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
        Buffer.from(
          JSON.stringify({
            iss: issuer,
            aud: "client",
            sub: subject,
            email: "owner@heyglide.com",
            email_verified: true,
            hd: material.company,
            nonce: material.nonce,
            iat: issuedAt,
            exp: issuedAt + 3600,
          }),
        ).toString("base64url"),
      ].join(".");
      return {
        access_token: "unused-test-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`,
      };
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
                agent: providerAgent,
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.on("error", reject);
                response.on("end", () =>
                  resolve(
                    new Response(Buffer.concat(chunks), {
                      status: response.statusCode ?? 500,
                      headers: {
                        "content-type": String(
                          response.headers["content-type"] ?? "application/json",
                        ),
                      },
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
    const task = new NoSimulationTask("application auth e2e", false);
    task.wallNow = () => now;
    const auth = createApplicationAuth({
      task,
      origins: [appOrigin, filesOrigin],
      provider,
      cookies: createSealedAuthCookies(
        "test-owned-restart-stable-cookie-sealing-secret",
      )._unsafeUnwrap(),
      machine: {
        verify: () => errAsync({ type: "unauthenticated", message: "No machine in this fixture" }),
      },
      ids: { next: () => ok("durable-user-uuid") },
      users: {
        getUser: () => {
          throw new Error("Stateless admission must not read users");
        },
        resolveUser: (_task, identity) => {
          resolutions++;
          return okAsync({ id: `durable-${identity.subject}`, email: identity.email });
        },
      },
    });
    await app.register(websocket);
    registerHostingAccessGuard(app, createHostingAccessPolicy(origins)._unsafeUnwrap(), appOrigin);
    app.addHook("onRequest", async (request) => {
      if (request.url.startsWith("/auth/callback")) loginCookie = request.headers.cookie ?? "";
    });
    registerAuthRoutes(app, origins, auth, authOutcome);
    app.get("/", async (_request, reply) =>
      reply.type("text/html").send("<p>Application shell</p>"),
    );
    app.get("/draft", async (_request, reply) =>
      reply.type("text/html").send("<p>Draft destination</p>"),
    );
    registerAuthenticatedBrowserRoutes(
      app,
      createGoogleRequestPrincipalResolver(origins, auth),
      (scope) => {
        scope.get("/api/private", async (request) => ({ principal: request.principal }));
        scope.post("/api/mutate", async () => {
          mutations++;
          return { ok: true };
        });
        scope.get("/socket", { websocket: true }, (socket) => socket.send("admitted"));
        scope.get("/s/orb/index.html", async (_request, reply) =>
          reply
            .header("cache-control", "private, no-store")
            .type("text/html")
            .send('<body><p>Private hosted file</p><script src="./asset.js"></script></body>'),
        );
        scope.get("/s/orb/asset.js", async (_request, reply) =>
          reply
            .header("cache-control", "private, no-store")
            .type("text/javascript")
            .send('document.body.dataset.asset = "loaded";'),
        );
      },
      { origins, auth, outcome: authOutcome },
    );
    await google.ready();
    await app.ready();
    return {
      ...origins,
      proxyUrl: proxy.url,
      advance: (ms: number) => {
        now += ms;
      },
      account: (value: string) => {
        subject = value;
      },
      outcomes: () => outcomes,
      company: (value: string) => {
        company = value;
      },
      substituteState: (value: boolean) => {
        replaceState = value;
      },
      lastCallback: () => callback,
      lastLoginCookie: () => loginCookie,
      tokenExchanges: () => exchanges,
      identityResolutions: () => resolutions,
      mutations: () => mutations,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
