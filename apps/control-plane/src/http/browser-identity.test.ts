import websocketPlugin from "@fastify/websocket";
import { ControlPlaneHttpErrorSchema } from "@pi-orb/protocol";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { registerAuthenticatedBrowserRoutes, requirePrincipal } from "./browser-identity.ts";

describe("authenticated browser route scope", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("protects every registered HTTP family while leaving runtime routes outside", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/v1/runtime", async () => ({ runtime: true }));
    registerAuthenticatedBrowserRoutes(
      app,
      (request) =>
        request.headers.authorization === "good"
          ? okAsync({ kind: "user" as const, user: { id: "user-1", email: null } })
          : errAsync({ type: "unauthenticated" as const, message: "invalid identity" }),
      async (scope) => {
        for (const path of [
          "/api/v1/session",
          "/api/v1/projects",
          "/api/v1/mcp/oauth/callback",
          "/api/v1/uploads",
          "/api/v1/orbs/orb/live",
          "/api/v1/orbs/orb/terminal",
          "/s/orb/file",
        ]) {
          scope.get(path, async (request) => ({
            principal: requirePrincipal(request)._unsafeUnwrap(),
          }));
        }
      },
    );
    await app.ready();
    for (const url of [
      "/api/v1/session",
      "/api/v1/projects",
      "/api/v1/mcp/oauth/callback",
      "/api/v1/uploads",
      "/api/v1/orbs/orb/live",
      "/api/v1/orbs/orb/terminal",
      "/s/orb/file",
    ]) {
      const denied = await app.inject({ url });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe("unauthorized");
      expect(Check(ControlPlaneHttpErrorSchema, denied.json())).toBe(true);
      expect((await app.inject({ url, headers: { authorization: "good" } })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: "/v1/runtime" })).statusCode).toBe(200);
  });

  it("only initiates files login for top-level GET navigation", async () => {
    const app = Fastify();
    apps.push(app);
    registerAuthenticatedBrowserRoutes(
      app,
      () => errAsync({ type: "unauthenticated", message: "denied" }),
      (scope) => {
        scope.get("/s/orb/file", async () => ({}));
        scope.get("/api/private", async () => ({}));
      },
      {
        origins: { appOrigin: "https://app.test", filesOrigin: "https://files.test" },
        auth: {
          startLogin: (_origin, returnTo) =>
            okAsync({
              authorizationUrl: `https://provider.test/login?return=${encodeURIComponent(returnTo)}`,
              loginCookieValue: "sealed",
            }),
        },
      },
    );
    const navigation = {
      host: "files.test",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    expect((await app.inject({ url: "/s/orb/file?q=1", headers: navigation })).statusCode).toBe(
      302,
    );
    expect(
      (await app.inject({ method: "HEAD", url: "/s/orb/file", headers: navigation })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/s/orb/file", headers: { host: "files.test" } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/private", headers: { ...navigation, host: "app.test" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/s/orb/file",
          headers: { ...navigation, authorization: "invalid" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("keeps concurrent principals request-local with explicit scheduling", async () => {
    const app = Fastify();
    apps.push(app);
    let enterA: (() => void) | undefined;
    let releaseA: (() => void) | undefined;
    const aEntered = new Promise<void>((resolve) => {
      enterA = resolve;
    });
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    registerAuthenticatedBrowserRoutes(
      app,
      (request) =>
        okAsync({
          kind: "user" as const,
          user: { id: String(request.headers["x-user"]), email: null },
        }),
      async (scope) => {
        scope.get("/who", async (request) => {
          if (request.headers["x-user"] === "a") {
            enterA?.();
            await aGate;
          }
          return requirePrincipal(request)._unsafeUnwrap();
        });
      },
    );
    await app.ready();
    const aPending = app.inject({ url: "/who", headers: { "x-user": "a" } });
    await aEntered;
    const b = await app.inject({ url: "/who", headers: { "x-user": "b" } });
    releaseA?.();
    const a = await aPending;
    expect(a.json().user.id).toBe("a");
    expect(b.json().user.id).toBe("b");
  });

  it("denies real WebSocket upgrades before handler effects and preserves accepted principal", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocketPlugin);
    let handlerEffects = 0;
    let acceptedPrincipal: unknown = null;
    registerAuthenticatedBrowserRoutes(
      app,
      (request) =>
        request.headers.authorization === "good"
          ? okAsync({ kind: "user" as const, user: { id: "user-1", email: null } })
          : request.headers.authorization === "outage"
            ? errAsync({ type: "identity_unavailable" as const, message: "unavailable" })
            : errAsync({ type: "unauthenticated" as const, message: "invalid identity" }),
      (scope) => {
        for (const path of ["/live", "/terminal"]) {
          scope.get(path, { websocket: true }, async (socket, request) => {
            handlerEffects += 1;
            acceptedPrincipal = requirePrincipal(request)._unsafeUnwrap();
            socket.close();
          });
        }
      },
    );
    await app.ready();
    await expect(app.injectWS("/live")).rejects.toThrow("401");
    await expect(
      app.injectWS("/terminal", { headers: { authorization: "outage" } }),
    ).rejects.toThrow("503");
    expect(handlerEffects).toBe(0);
    const accepted = await app.injectWS("/live", { headers: { authorization: "good" } });
    accepted.close();
    expect(handlerEffects).toBe(1);
    expect(acceptedPrincipal).toEqual({ kind: "user", user: { id: "user-1", email: null } });
  });

  it("maps verifier outage, store outage, and invariants without leaking details", async () => {
    for (const [error, status] of [
      [{ type: "identity_unavailable" as const, message: "verification unavailable" }, 503],
      [
        {
          type: "store_error" as const,
          code: "unavailable" as const,
          message: "database unavailable",
          retryable: true,
        },
        503,
      ],
      [
        {
          type: "store_error" as const,
          code: "invariant" as const,
          message: "raw SQL secret",
          retryable: false,
        },
        500,
      ],
    ] as const) {
      const app = Fastify();
      apps.push(app);
      registerAuthenticatedBrowserRoutes(
        app,
        () => errAsync(error),
        (scope) => {
          scope.get("/protected", async () => ({}));
        },
      );
      await app.ready();
      const response = await app.inject({ url: "/protected" });
      expect(response.statusCode).toBe(status);
      if (status === 500) expect(response.body).not.toContain("raw SQL secret");
    }
  });
});
