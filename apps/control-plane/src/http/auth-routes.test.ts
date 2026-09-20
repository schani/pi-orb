import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { registerAuthRoutes } from "./auth-routes.ts";
import { createHostingAccessPolicy, registerHostingAccessGuard } from "./hosting-access.ts";

it("scopes login/callback to configured hosts and protects app-only logout", async () => {
  const app = Fastify();
  registerHostingAccessGuard(
    app,
    createHostingAccessPolicy({
      appOrigin: "https://app.test",
      filesOrigin: "https://files.test",
    })._unsafeUnwrap(),
    "https://app.test",
  );
  let complete = 0;
  const outcomes: unknown[] = [];
  registerAuthRoutes(
    app,
    { appOrigin: "https://app.test", filesOrigin: "https://files.test" },
    {
      startLogin: () =>
        okAsync({
          authorizationUrl: "https://accounts.google.com/login",
          loginCookieValue: "transaction",
        }),
      completeLogin: (_origin, _url, cookie) => {
        complete++;
        return cookie === "transaction"
          ? okAsync({ sessionCookieValue: "sealed", returnTo: "/s/orb/page#hash" })
          : errAsync({ type: "unauthenticated", message: "secret code" });
      },
    },
    (event) => outcomes.push(event),
  );
  for (const host of ["app.test", "files.test"]) {
    const login = await app.inject({
      url: "/auth/login?returnTo=%2Fs%2Forb%2Fpage%23hash",
      headers: { host },
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers["set-cookie"]).toContain("__Host-pi-orb-login=transaction");
    const callback = await app.inject({
      url: "/auth/callback?code=secret",
      headers: {
        host,
        cookie: "__Host-pi-orb-login=transaction",
        origin: "https://accounts.google.com",
      },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/s/orb/page#hash");
    expect(callback.headers["set-cookie"]?.toString()).toContain("HttpOnly");
  }
  expect(complete).toBe(2);
  expect(outcomes).toHaveLength(4);
  expect(JSON.stringify(outcomes)).not.toMatch(/transaction|sealed|code=|secret/u);
  const failed = await app.inject({
    url: "/auth/callback?code=secret",
    headers: { host: "app.test" },
  });
  expect(failed.statusCode).toBe(401);
  expect(failed.body).not.toContain("secret");
  expect(failed.headers["cache-control"]).toBe("no-store");
  expect(failed.headers["referrer-policy"]).toBe("no-referrer");
  expect(failed.headers["set-cookie"]).toContain("__Host-pi-orb-login=;");
  expect(
    (
      await app.inject({
        url: "/auth/login?returnTo=/api/private",
        headers: { host: "files.test" },
      })
    ).statusCode,
  ).toBe(401);
  expect(failed.headers["set-cookie"]?.toString() ?? "").not.toContain("__Host-pi-orb-session");
  expect(
    (
      await app.inject({
        url: "/auth/login",
        headers: { host: "evil.test", "x-forwarded-host": "app.test" },
      })
    ).statusCode,
  ).toBe(403);
  for (const origin of [undefined, "null", "https://files.test"])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { host: "app.test", ...(origin ? { origin } : {}) },
        })
      ).statusCode,
    ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { host: "files.test", origin: "https://files.test" },
      })
    ).statusCode,
  ).toBe(403);
  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { host: "app.test", origin: "https://app.test" },
  });
  expect(logout.statusCode).toBe(204);
  expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
  await app.close();
});
