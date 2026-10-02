import websocket from "@fastify/websocket";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUER_CONSTANTS } from "./domain/constants.ts";
import { registerAuthenticatedBrowserRoutes } from "./http/browser-identity.ts";
import { createHostingAccessPolicy, registerHostingAccessGuard } from "./http/hosting-access.ts";
import {
  JWKS_PATH,
  OPENID_CONFIGURATION_PATH,
  registerIssuerRoutes,
} from "./http/issuer-routes.ts";
import {
  createGoogleRequestPrincipalResolver,
  readRequestIdentityConfig,
} from "./identity-composition.ts";
import { FakeSigningKeyStore } from "./testkit/workload-identity.ts";

const environment = {
  PI_ORB_AUTH_MODE: "google",
  PI_ORB_GOOGLE_CLIENT_ID: "client",
  PI_ORB_GOOGLE_CLIENT_SECRET: "secret",
  PI_ORB_COOKIE_SECRET: "01234567890123456789012345678901",
  PI_ORB_MACHINE_SUBJECT: "machine",
  PI_ORB_APP_ORIGIN: "https://app.test",
  PI_ORB_HOSTING_ORIGIN: "https://files.test",
};
describe("application identity composition", () => {
  it("fails closed in production and requires all Google configuration", () => {
    expect(
      readRequestIdentityConfig({ K_SERVICE: "prod", PI_ORB_AUTH_MODE: "local" }).isErr(),
    ).toBe(true);
    expect(readRequestIdentityConfig({ PI_ORB_AUTH_MODE: "local" }).isOk()).toBe(true);
    expect(readRequestIdentityConfig({}).isErr()).toBe(true);
    expect(readRequestIdentityConfig(environment).isOk()).toBe(true);
    for (const value of [
      "http://app.test",
      "https://app.test/path",
      "https://files.test:8443",
      "https://user@app.test",
      "https://app.test?x",
    ])
      expect(readRequestIdentityConfig({ ...environment, PI_ORB_APP_ORIGIN: value }).isErr()).toBe(
        true,
      );
    expect(
      readRequestIdentityConfig({ ...environment, PI_ORB_COOKIE_SECRET: "short" }).isErr(),
    ).toBe(true);
    expect(
      readRequestIdentityConfig({ ...environment, PI_ORB_MACHINE_SUBJECT: "  " }).isErr(),
    ).toBe(true);
    for (const key of Object.keys(environment))
      expect(readRequestIdentityConfig({ ...environment, [key]: "" }).isErr()).toBe(true);
  });
  it("separates bearer and cookie authority; unsafe cookies require exact Origin", async () => {
    const app = Fastify();
    await app.register(websocket);
    registerHostingAccessGuard(
      app,
      createHostingAccessPolicy({
        appOrigin: environment.PI_ORB_APP_ORIGIN,
        filesOrigin: environment.PI_ORB_HOSTING_ORIGIN,
      })._unsafeUnwrap(),
      environment.PI_ORB_APP_ORIGIN,
    );
    const keys = new FakeSigningKeyStore();
    keys.seedKey({
      kid: "key",
      secretVersion: "secret",
      publicJwk: { kty: "RSA", kid: "key", n: "modulus", e: "AQAB" },
      state: "active",
      createdAt: 0,
      activatedAt: 0,
      retiredAt: null,
      rowVersion: 0,
    });
    registerIssuerRoutes(app, new NoSimulationTask("identity scopes", false), {
      keys,
      constants: DEFAULT_ISSUER_CONSTANTS,
      issuerUrl: environment.PI_ORB_APP_ORIGIN,
    });
    app.get("/", async () => "shell");
    let upgrades = 0;
    let writes = 0;
    const resolver = createGoogleRequestPrincipalResolver(
      { appOrigin: environment.PI_ORB_APP_ORIGIN, filesOrigin: environment.PI_ORB_HOSTING_ORIGIN },
      {
        authenticateSession: () =>
          okAsync({ principal: { kind: "user", user: { id: "u", email: null } }, expiresAt: 1234 }),
        authenticateMachine: (token) =>
          token === "valid"
            ? okAsync({ kind: "ops", id: "machine" })
            : errAsync({ type: "unauthenticated", message: "secret" }),
      },
    );
    registerAuthenticatedBrowserRoutes(app, resolver, (scope) => {
      scope.get("/api/read", async (request) => ({
        principal: request.principal,
        expiry: request.authExpiresAt,
      }));
      scope.post("/api/write", async () => {
        writes++;
        return {};
      });
      for (const path of ["/live", "/terminal"])
        scope.get(path, { websocket: true }, (socket) => {
          upgrades++;
          socket.close();
        });
    });
    for (const url of ["/", OPENID_CONFIGURATION_PATH, JWKS_PATH]) {
      for (const origin of ["null", "https://files.test", "https://arbitrary.test"]) {
        const response = await app.inject({ url, headers: { host: "app.test", origin } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
        expect(
          (await app.inject({ url, headers: { host: "files.test", origin } })).statusCode,
        ).toBe(404);
      }
    }
    expect((await app.inject({ url: "/api/read", headers: { host: "app.test" } })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: "/api/read",
          headers: { host: "files.test", authorization: "Bearer valid" },
        })
      ).statusCode,
    ).toBe(404);
    const headers = { host: "app.test", cookie: "__Host-pi-orb-session=sealed" };
    expect((await app.inject({ url: "/api/read", headers })).json().expiry).toBe(1234);
    for (const origin of [undefined, "null", "https://files.test", "https://evil.test"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/write",
            headers: { ...headers, ...(origin ? { origin } : {}) },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(writes).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/write",
          headers: { ...headers, origin: "https://app.test" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/write",
          headers: { host: "app.test", authorization: "Bearer valid" },
        })
      ).statusCode,
    ).toBe(200);
    for (const origin of ["null", "https://files.test", "https://arbitrary.test"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/write",
            headers: { ...headers, origin, authorization: "Bearer valid" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/write",
            headers: { ...headers, origin, authorization: "Bearer invalid" },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(writes).toBe(5);
    expect(
      (
        await app.inject({
          url: "/api/read",
          headers: { ...headers, authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/read",
          headers: { ...headers, host: "evil.test", "x-forwarded-host": "app.test" },
        })
      ).statusCode,
    ).toBe(403);
    for (const path of ["/live", "/terminal"]) {
      for (const origin of [undefined, "null", "https://files.test"])
        await expect(
          app.injectWS(path, { headers: { ...headers, ...(origin ? { origin } : {}) } }),
        ).rejects.toThrow("403");
    }
    expect(upgrades).toBe(0);
    const socket = await app.injectWS("/live", {
      headers: { ...headers, origin: "https://app.test" },
    });
    socket.close();
    expect(upgrades).toBe(1);
    await app.close();
  });
});
