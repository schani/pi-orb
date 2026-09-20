import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  createHostingAccessPolicy,
  type HostingAccessOutcome,
  registerHostingAccessGuard,
} from "./hosting-access.ts";

const policy = (trustedLocal = false) =>
  createHostingAccessPolicy({
    appOrigin: "https://app.test",
    filesOrigin: "https://files.test",
    trustedLocal,
  })._unsafeUnwrap();
it("limits the configured runtime authority to runtime routes", () => {
  const config = {
    appOrigin: "https://app.test",
    filesOrigin: "https://files.test",
    runtimeOrigin: "https://broker.test:8443",
  };
  const access = createHostingAccessPolicy(config)._unsafeUnwrap();
  for (const path of [
    "/runtime",
    "/runtime/v1/orb/boot-context",
    "/runtime/v1/model-token?scope=test",
  ])
    expect(access.decide({ method: "POST", path, host: "broker.test:8443" }).kind).toBe("allow");
  for (const path of [
    "/",
    "/api/v1/orbs",
    "/auth/login",
    "/s/orb/index.html",
    "/runtime-other",
    "/runtimeevil",
  ])
    expect(access.decide({ method: "GET", path, host: "broker.test:8443" }).kind).toBe("reject");
  for (const host of ["broker.test", "unknown.test", "broker.test:8444"])
    expect(access.decide({ method: "POST", path: "/runtime/v1/model-token", host }).kind).toBe(
      "reject",
    );
  expect(
    access.decide({ method: "GET", path: "/runtime/v1/orb/boot-context", host: "files.test" }).kind,
  ).toBe("isolated_not_found");
  expect(
    access.decide({ method: "POST", path: "/runtime/v1/model-token", host: "files.test" }).kind,
  ).toBe("reject");
});
it.each([
  "https://broker.test/path",
  "https://user:secret@broker.test",
  "https://broker.test?q=1",
  "https://broker.test#fragment",
  "ftp://broker.test",
  "https://files.test:8443",
])("rejects invalid runtime origin %s", (runtimeOrigin) => {
  const config = {
    appOrigin: "https://app.test",
    filesOrigin: "https://files.test",
    runtimeOrigin,
  };
  expect(createHostingAccessPolicy(config).isErr()).toBe(true);
});
it("passes runtime requests through to bearer authentication", async () => {
  const config = {
    appOrigin: "https://app.test",
    filesOrigin: "https://files.test",
    runtimeOrigin: "https://broker.test",
  };
  const app = Fastify();
  registerHostingAccessGuard(
    app,
    createHostingAccessPolicy(config)._unsafeUnwrap(),
    "https://app.test",
  );
  app.post("/runtime/v1/model-token", async (request, reply) => {
    if (request.headers.authorization !== "Bearer runtime-secret")
      return reply.code(401).send({ error: "unauthorized" });
    return { token: "issued" };
  });
  try {
    for (const authorization of [undefined, "Bearer invalid", "Bearer runtime-secret"]) {
      const response = await app.inject({
        method: "POST",
        url: "/runtime/v1/model-token",
        headers: { host: "broker.test", ...(authorization === undefined ? {} : { authorization }) },
      });
      expect(response.statusCode).toBe(authorization === "Bearer runtime-secret" ? 200 : 401);
    }
  } finally {
    await app.close();
  }
});
it("trusts only configured hosts, not request-derived origins", () => {
  for (const host of ["evil.test", "app.test:8443", "files.test:8443", "app.test@evil.test"])
    expect(policy().decide({ method: "GET", path: "/", host }).kind).toBe("reject");
  expect(policy().decide({ method: "GET", path: "/", host: "app.test" }).kind).toBe("allow");
});
it("leaves credential-specific Origin checks to authentication", () => {
  for (const method of ["GET", "POST"])
    for (const origin of [undefined, "null", "https://files.test", "https://evil.test"])
      expect(
        policy().decide({
          method,
          path: "/api/write",
          host: "app.test",
          ...(origin === undefined ? {} : { origin }),
        }).kind,
      ).toBe("allow");
});
it("files exposes only reads and GET authentication entrypoints", () => {
  for (const path of ["/auth/login", "/auth/callback", "/s/orb/index.html"])
    expect(policy().decide({ method: "GET", path, host: "files.test" }).kind).toBe("allow");
  for (const path of ["/api/v1/orbs", "/runtime/v1", "/.well-known/jwks.json", "/auth/logout", "/"])
    expect(policy().decide({ method: "GET", path, host: "files.test" }).kind).toBe(
      "isolated_not_found",
    );
  expect(policy().decide({ method: "POST", path: "/s/orb/file", host: "files.test" }).kind).toBe(
    "reject",
  );
  expect(
    policy().decide({
      method: "GET",
      path: "/s/orb/file",
      host: "files.test",
      upgrade: "websocket",
    }).kind,
  ).toBe("reject");
  expect(policy().decide({ method: "GET", path: "/s/orb/file", host: "app.test" }).kind).toBe(
    "reject",
  );
});
it("preserves trusted-local Origin protection and GET OAuth callback exceptions", async () => {
  const app = Fastify();
  registerHostingAccessGuard(app, policy(true), "https://app.test");
  app.post("/api/write", async () => ({}));
  app.get("/auth/callback", async () => ({}));
  for (const origin of ["null", "https://files.test", "https://evil.test"])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/write",
          headers: { host: "app.test", origin },
        })
      ).statusCode,
    ).toBe(403);
  expect(
    (await app.inject({ method: "POST", url: "/api/write", headers: { host: "app.test" } }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: "/auth/callback",
        headers: { host: "app.test", origin: "https://provider.test" },
      })
    ).statusCode,
  ).toBe(200);
  for (const path of ["/auth/callback", "/api/v1/mcp/oauth/callback"]) {
    expect(
      policy(true).decide({
        method: "GET",
        path,
        host: "app.test",
        origin: "https://provider.test",
      }).kind,
    ).toBe("allow");
    expect(
      policy(true).decide({
        method: "POST",
        path,
        host: "app.test",
        origin: "https://provider.test",
      }).kind,
    ).toBe("reject");
  }
  await app.close();
});
it("records sanitized host and route denials, never accepted requests", async () => {
  const outcomes: HostingAccessOutcome[] = [];
  const app = Fastify();
  registerHostingAccessGuard(app, policy(), "https://app.test", (outcome) =>
    outcomes.push(outcome),
  );
  let calls = 0;
  app.get("/", async () => {
    calls++;
    return {};
  });
  const cases = [
    {
      host: "secret.evil.test",
      url: "/?code=secret",
      reason: "unknown_host",
      surface: "unknown",
      status: 403,
    },
    {
      host: "app.test@secret.evil.test",
      url: "/?code=secret",
      reason: "invalid_host",
      surface: "unknown",
      status: 403,
    },
    {
      host: "app.test",
      url: "/s/private-orb/secret?token=secret",
      reason: "files_wrong_host",
      surface: "app",
      status: 403,
    },
    {
      host: "files.test",
      url: "/auth/callback?code=secret",
      method: "POST" as const,
      reason: "files_method",
      surface: "files",
      status: 403,
    },
    {
      host: "files.test",
      url: "/?code=secret",
      reason: "files_route",
      surface: "files",
      status: 404,
    },
    {
      host: "files.test",
      url: "/s/private-orb/secret",
      upgrade: "websocket",
      reason: "files_websocket",
      surface: "files",
      status: 403,
    },
  ];
  for (const test of cases) {
    const result = await app.inject({
      method: test.method ?? "GET",
      url: test.url,
      headers: {
        host: test.host,
        cookie: "secret",
        authorization: "Bearer secret",
        origin: "https://secret.test",
        ...(test.upgrade ? { upgrade: test.upgrade } : {}),
      },
    });
    expect(result.statusCode).toBe(test.status);
    expect(outcomes.at(-1)).toEqual({
      event: "hosting_denial",
      reason: test.reason,
      surface: test.surface,
      requestId: expect.any(String),
    });
  }
  expect(calls).toBe(0);
  expect(outcomes).toHaveLength(cases.length);
  expect(JSON.stringify(outcomes)).not.toMatch(/secret|private-orb|code=|token=/u);
  expect((await app.inject({ url: "/", headers: { host: "app.test" } })).statusCode).toBe(200);
  expect(calls).toBe(1);
  expect(outcomes).toHaveLength(cases.length);
  await app.close();
});
