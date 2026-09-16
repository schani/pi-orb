import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import type { UserStore } from "./domain/identity.ts";
import { registerAuthenticatedBrowserRoutes, requirePrincipal } from "./http/browser-identity.ts";
import {
  createRequestPrincipalResolver,
  readRequestIdentityConfig,
} from "./identity-composition.ts";

const task = new NoSimulationTask("request identity composition", false);
const ids = { next: () => ok("00000000-0000-4000-8000-000000000001") };

describe("request identity role composition", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("fails browser configuration without a valid direct Cloud Run audience", () => {
    expect(readRequestIdentityConfig("browser", {}).isErr()).toBe(true);
    expect(
      readRequestIdentityConfig("browser", {
        PI_ORB_IAP_AUDIENCE: "https://service.run.app",
      }).isErr(),
    ).toBe(true);
    expect(
      readRequestIdentityConfig("browser", {
        PI_ORB_IAP_AUDIENCE: "/projects/123/locations/us-central1/services/pi-orb",
      })._unsafeUnwrap(),
    ).toEqual({
      kind: "browser",
      audience: "/projects/123/locations/us-central1/services/pi-orb",
    });
  });

  it("uses the fixed local identity and ignores spoofed identity headers", async () => {
    const seen: unknown[] = [];
    const users: UserStore = {
      getUser: () => okAsync(null),
      resolveUser: (_task, identity, input) => {
        seen.push(identity);
        return okAsync({ id: input.id, email: identity.email });
      },
    };
    const config = readRequestIdentityConfig("all", {})._unsafeUnwrap();
    expect(config.kind).toBe("local");
    if (config.kind === "none") return;
    const resolver = createRequestPrincipalResolver(task, config, users, ids)._unsafeUnwrap();
    const app = Fastify();
    apps.push(app);
    registerAuthenticatedBrowserRoutes(app, resolver, (scope) => {
      scope.get("/session", async (request) => requirePrincipal(request)._unsafeUnwrap());
    });
    await app.ready();
    const response = await app.inject({
      url: "/session",
      headers: { "x-goog-iap-jwt-assertion": "spoof", "x-goog-authenticated-user-email": "spoof" },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ issuer: "pi-orb:local", subject: "developer", email: null }]);
  });

  it("requires a fixed ops principal and bypasses the users store", async () => {
    expect(readRequestIdentityConfig("ops", {}).isErr()).toBe(true);
    const config = readRequestIdentityConfig("ops", {
      PI_ORB_OPS_PRINCIPAL: "machine",
    })._unsafeUnwrap();
    expect(config.kind).toBe("ops");
    if (config.kind === "none") return;
    let storeReads = 0;
    const resolver = createRequestPrincipalResolver(
      task,
      config,
      {
        getUser: () => okAsync(null),
        resolveUser: () => {
          storeReads += 1;
          return okAsync({ id: "wrong", email: null });
        },
      },
      ids,
    )._unsafeUnwrap();
    const app = Fastify();
    apps.push(app);
    registerAuthenticatedBrowserRoutes(app, resolver, (scope) => {
      scope.get("/session", async (request) => requirePrincipal(request)._unsafeUnwrap());
    });
    await app.ready();
    expect((await app.inject({ url: "/session" })).json()).toEqual({ kind: "ops", id: "machine" });
    expect(storeReads).toBe(0);
  });

  it("leaves runtime and issuer outside request identity", () => {
    expect(readRequestIdentityConfig("runtime", {})._unsafeUnwrap()).toEqual({ kind: "none" });
    expect(readRequestIdentityConfig("issuer", {})._unsafeUnwrap()).toEqual({ kind: "none" });
  });

  it("keeps every real browser family inside the authenticated scope", () => {
    const main = readFileSync(resolve("apps/control-plane/src/main.ts"), "utf8");
    const scopeStart = main.indexOf("registerAuthenticatedBrowserRoutes(");
    const scopeEnd = main.indexOf("if (runtimeRole)", scopeStart);
    expect(scopeStart).toBeGreaterThan(-1);
    expect(scopeEnd).toBeGreaterThan(scopeStart);
    const scope = main.slice(scopeStart, scopeEnd);
    for (const registration of [
      "registerBrowserHostingRoutes(browser",
      "registerLiveProxy(browser",
      "registerRoutes(browser",
      "registerMcpOAuthRoutes(browser",
      "registerMcpRoutes(browser",
      "registerWorkspaceUploadRoutes(browser",
    ]) {
      expect(scope).toContain(registration);
    }
  });
});
