import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { createSealedPreviewAuth } from "../adapters/sealed-preview-cookies.ts";
import {
  PREVIEW_CHALLENGE_COOKIE_NAME,
  PREVIEW_SESSION_COOKIE_NAME,
} from "../domain/preview-auth.ts";
import { registerPreviewAuth } from "./preview-auth-routes.ts";
import { createPreviewHosts } from "./preview-host.ts";

it("authenticates before all routes, bootstraps with POST proof and never redirects subresources", async () => {
  const app = Fastify();
  const appOrigin = "https://app.example.com";
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.net",
    appOrigin,
    filesOrigin: "https://files.example.org",
  })._unsafeUnwrap();
  const origin = hosts.url("12345678-1234-4234-8234-123456789abc", 5173)._unsafeUnwrap();
  const host = new URL(origin).host;
  const identity = {
    principal: { kind: "user" as const, user: { id: "coworker", email: null } },
    expiresAt: Date.now() + 120_000,
  };
  const auth = createSealedPreviewAuth(
    "a sufficiently long shared cookie sealing key",
    Date.now,
  )._unsafeUnwrap();
  registerPreviewAuth(app, {
    hosts,
    appOrigin,
    previewAuth: auth,
    applicationAuth: {
      authenticateSession: (_o, cookie) =>
        cookie === "app-session" ? okAsync(identity) : auth.authenticate("wrong", cookie),
    },
  });
  let platform = 0;
  app.get("/api/private", () => {
    platform++;
    return "platform";
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.previewIdentity)
      return reply.send({
        user: request.previewIdentity.principal.user.id,
        authorization: request.headers.authorization,
      });
  });
  app.get("/*", () => "app");
  for (const headers of [
    {},
    { accept: "text/html" },
    { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    { upgrade: "websocket" },
  ]) {
    expect((await app.inject({ url: "/deep", headers: { host, ...headers } })).statusCode).toBe(
      401,
    );
  }
  const nav = await app.inject({
    url: "/deep?q=1",
    headers: { host, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  expect(nav.statusCode).toBe(302);
  expect(nav.headers.location).toBe("/__pi_orb/auth/start?returnTo=%2Fdeep%3Fq%3D1");
  const start = await app.inject({ url: nav.headers.location!, headers: { host } });
  expect(start.statusCode).toBe(302);
  const challengeCookie = start.cookies.find(
    (cookie) => cookie.name === PREVIEW_CHALLENGE_COOKIE_NAME,
  )!;
  expect(start.headers["set-cookie"]?.toString()).toMatch(/HttpOnly; Secure; SameSite=None/u);
  const handoffPath = start.headers.location!.slice(appOrigin.length);
  const login = await app.inject({ url: handoffPath, headers: { host: new URL(appOrigin).host } });
  expect(login.headers.location).toMatch(/^\/auth\/login\?returnTo=/u);
  const handoff = await app.inject({
    url: handoffPath,
    headers: { host: new URL(appOrigin).host, cookie: "__Host-pi-orb-session=app-session" },
  });
  expect(handoff.statusCode).toBe(200);
  expect(handoff.headers["referrer-policy"]).toBe("strict-origin");
  expect(handoff.headers["cache-control"]).toBe("no-store");
  expect(handoff.headers["content-security-policy"]).toContain("script-src 'nonce-");
  const ticket = /name="ticket" value="([^"]+)"/u.exec(handoff.body)![1]!;
  expect(handoff.headers.location).toBeUndefined();
  const callback = await app.inject({
    method: "POST",
    url: "/__pi_orb/auth/callback",
    headers: {
      host,
      origin: appOrigin,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${challengeCookie.name}=${challengeCookie.value}`,
    },
    payload: new URLSearchParams({ ticket }).toString(),
  });
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe("/deep?q=1");
  expect(callback.headers["set-cookie"]?.toString()).toContain(
    `${PREVIEW_CHALLENGE_COOKIE_NAME}=;`,
  );
  const session = callback.cookies.find((cookie) => cookie.name === PREVIEW_SESSION_COOKIE_NAME)!;
  const admitted = await app.inject({
    url: "/api/private",
    headers: {
      host,
      cookie: `${session.name}=${session.value}`,
      authorization: "Bearer application",
    },
  });
  expect(admitted.json()).toEqual({ user: "coworker", authorization: "Bearer application" });
  expect(platform).toBe(0);
  for (const [method, payload, contentType, callbackOrigin] of [
    ["GET", undefined, undefined, appOrigin],
    ["POST", "ticket=x", "text/plain", appOrigin],
    ["POST", "ticket=x", "application/x-www-form-urlencoded", origin],
    ["POST", "ticket=x", "application/x-www-form-urlencoded", "null"],
    ["POST", "x".repeat(17000), "application/x-www-form-urlencoded", appOrigin],
  ] as const) {
    const failed = await app.inject({
      method,
      url: "/__pi_orb/auth/callback",
      headers: {
        host,
        origin: callbackOrigin,
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(payload ? { payload } : {}),
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(failed.headers["set-cookie"]?.toString()).toContain(
      `${PREVIEW_CHALLENGE_COOKIE_NAME}=;`,
    );
  }
  for (const originValue of [
    origin + ".evil.test",
    origin + ":443",
    origin + "/",
    origin + "/path",
  ]) {
    const invalid = await app.inject({
      url: `/auth/preview?origin=${encodeURIComponent(originValue)}&proof=proof`,
      headers: { host: new URL(appOrigin).host, cookie: "__Host-pi-orb-session=app-session" },
    });
    expect(invalid.statusCode).toBe(403);
  }
  await app.close();
});
