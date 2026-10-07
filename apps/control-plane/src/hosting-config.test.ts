import Fastify from "fastify";
import { expect, it } from "vitest";
import { createConfiguredHostingAccessPolicy, readHostingConfiguration } from "./hosting-config.ts";
import { registerHostingAccessGuard } from "./http/hosting-access.ts";

const env = {
  PI_ORB_AUTH_MODE: "google",
  PI_ORB_APP_ORIGIN: "https://app.test",
  PI_ORB_HOSTING_ORIGIN: "https://files.test",
  PI_ORB_HOSTING_STORE: "gcs",
  PI_ORB_HOSTING_BUCKET: "private",
};
it("requires production origins and separate hostnames", () => {
  expect(readHostingConfiguration(env, 7100, "/h").isOk()).toBe(true);
  for (const value of ["", "https://app.test/path", "https://files.test", "http://app.test"])
    expect(readHostingConfiguration({ ...env, PI_ORB_APP_ORIGIN: value }, 7100, "/h").isErr()).toBe(
      true,
    );
  expect(readHostingConfiguration({ ...env, PI_ORB_HOSTING_BUCKET: "" }, 7100, "/h").isErr()).toBe(
    true,
  );
  expect(
    readHostingConfiguration(
      { PI_ORB_AUTH_MODE: "local", K_SERVICE: "production" },
      7100,
      "/h",
    ).isErr(),
  ).toBe(true);
});
it.each([undefined, "docker"])(
  "admits default Docker runtime broker with provider %s",
  (provider) => {
    const configuration = readHostingConfiguration(
      {
        PI_ORB_AUTH_MODE: "local",
        ...(provider === undefined ? {} : { PI_ORB_HOST_PROVIDER: provider }),
      },
      7100,
      "/h",
    )._unsafeUnwrap();
    const access = createConfiguredHostingAccessPolicy(configuration)._unsafeUnwrap();
    for (const path of [
      "/runtime/v1/orb/boot-context",
      "/runtime/v1/model-token",
      "/runtime/v1/tokens/github",
    ])
      expect(access.decide({ method: "POST", path, host: "host.docker.internal:7100" }).kind).toBe(
        "allow",
      );
    for (const path of ["/api/v1/orbs", "/auth/login", "/s/orb/index.html", "/runtime-other"])
      expect(access.decide({ method: "GET", path, host: "host.docker.internal:7100" }).kind).toBe(
        "reject",
      );
  },
);
it("uses the configured broker authority without trusting it for browser routes", () => {
  const configuration = readHostingConfiguration(
    { ...env, PI_ORB_BROKER_URL: "https://broker.test:8443" },
    7100,
    "/h",
  )._unsafeUnwrap();
  const access = createConfiguredHostingAccessPolicy(configuration)._unsafeUnwrap();
  expect(
    access.decide({ method: "GET", path: "/runtime/v1/orb/boot-context", host: "broker.test:8443" })
      .kind,
  ).toBe("allow");
  for (const host of ["broker.test", "host.docker.internal:7100", "unknown.test"])
    expect(access.decide({ method: "GET", path: "/runtime/v1/orb/boot-context", host }).kind).toBe(
      "reject",
    );
  expect(
    access.decide({ method: "GET", path: "/api/v1/orbs", host: "broker.test:8443" }).kind,
  ).toBe("reject");
});
it("does not implicitly trust the Docker alias in cloud hosting", () => {
  const access = createConfiguredHostingAccessPolicy(
    readHostingConfiguration(env, 7100, "/h")._unsafeUnwrap(),
  )._unsafeUnwrap();
  expect(
    access.decide({ method: "GET", path: "/runtime/v1/orb/boot-context", host: "app.test" }).kind,
  ).toBe("allow");
  expect(
    access.decide({
      method: "GET",
      path: "/runtime/v1/orb/boot-context",
      host: "host.docker.internal:7100",
    }).kind,
  ).toBe("reject");
});
it("retains the process provider's app authority", () => {
  const access = createConfiguredHostingAccessPolicy(
    readHostingConfiguration(
      { PI_ORB_AUTH_MODE: "local", PI_ORB_HOST_PROVIDER: "process" },
      7100,
      "/h",
    )._unsafeUnwrap(),
  )._unsafeUnwrap();
  expect(
    access.decide({ method: "GET", path: "/runtime/v1/orb/boot-context", host: "127.0.0.1:7100" })
      .kind,
  ).toBe("allow");
});
it.each([undefined, "http://broker.test:7100"])(
  "isolates the local process broker with custom app origin and override %s",
  async (broker) => {
    const configuration = readHostingConfiguration(
      {
        PI_ORB_AUTH_MODE: "local",
        PI_ORB_HOST_PROVIDER: "process",
        PI_ORB_APP_ORIGIN: "http://preview.tailnet.test:5173",
        PI_ORB_HOSTING_ORIGIN: "http://100.87.202.110:7100",
        ...(broker === undefined ? {} : { PI_ORB_BROKER_URL: broker }),
      },
      7100,
      "/h",
    )._unsafeUnwrap();
    const runtimeHost = new URL(broker ?? "http://127.0.0.1:7100").host;
    const app = Fastify();
    registerHostingAccessGuard(
      app,
      createConfiguredHostingAccessPolicy(configuration)._unsafeUnwrap(),
      configuration.appOrigin,
    );
    app.get("/runtime/v1/project-secrets", async () => ({}));
    app.get("/api/v1/orbs", async () => ({}));
    app.get("/s/orb/index.html", async () => "fixture");
    try {
      for (const [host, path, status] of [
        [runtimeHost, "/runtime/v1/project-secrets", 200],
        [runtimeHost, "/api/v1/orbs", 403],
        ["preview.tailnet.test:5173", "/api/v1/orbs", 200],
        ["100.87.202.110:7100", "/s/orb/index.html", 200],
        ["100.87.202.110:7100", "/api/v1/orbs", 404],
        ["100.87.202.110:7100", "/runtime/v1/project-secrets", 404],
        ...(broker === undefined
          ? []
          : [["127.0.0.1:7100", "/runtime/v1/project-secrets", 403] as const]),
      ] as const)
        expect((await app.inject({ url: path, headers: { host } })).statusCode).toBe(status);
    } finally {
      await app.close();
    }
  },
);
it("retains the cloud GCE app broker default", () => {
  const configuration = readHostingConfiguration(
    { ...env, PI_ORB_HOST_PROVIDER: "gce" },
    7100,
    "/h",
  )._unsafeUnwrap();
  expect(configuration.runtimeOrigin).toBe(env.PI_ORB_APP_ORIGIN);
});
it.each([
  "https://broker.test/path",
  "https://user:secret@broker.test",
  "https://broker.test?query=1",
  "https://broker.test#fragment",
  "ftp://broker.test",
  "https://files.test:8443",
])("rejects invalid or files-colliding broker %s", (broker) => {
  expect(readHostingConfiguration({ ...env, PI_ORB_BROKER_URL: broker }, 7100, "/h").isErr()).toBe(
    true,
  );
});
it("uses local defaults only for explicit local auth", () => {
  const local = readHostingConfiguration({ PI_ORB_AUTH_MODE: "local" }, 7100, "/h")._unsafeUnwrap();
  const policy = createConfiguredHostingAccessPolicy(local)._unsafeUnwrap();
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"])
    expect(
      policy.decide({ method: "POST", path: "/api/write", host: new URL(origin).host, origin })
        .kind,
    ).toBe("allow");
  expect(
    policy.decide({
      method: "POST",
      path: "/api/write",
      host: "127.0.0.1:7100",
      origin: "http://files.localhost:7100",
    }).kind,
  ).toBe("reject");
  expect(readHostingConfiguration({}, 7100, "/h").isErr()).toBe(true);
  expect(
    readHostingConfiguration({ PI_ORB_AUTH_MODE: "local" }, 7100, "/h")._unsafeUnwrap().filesOrigin,
  ).toBe("http://files.localhost:7100");
});
