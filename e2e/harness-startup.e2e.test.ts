import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  controlPlaneRequest,
  fetchIssuerKeys,
  startControlPlane,
  waitFor,
  waitForOwnedControlPlane,
} from "./harness.ts";

const fake = {
  sessionKey: "unused",
  oauthBaseUrl: "https://unused.test",
  inferenceBaseUrl: "https://unused.test",
};
const entry = "e2e/testkit/control-plane-readiness-probe.ts";

describe("startControlPlane", () => {
  it.each(["host", "Host", "hOsT"])(
    "preserves explicit %s through owned ephemeral child and ingress listeners",
    async (header) => {
      const cp = await startControlPlane({
        port: 0,
        fake,
        entry,
        readinessPath: "/health",
        readinessHeaders: { [header]: "app.test" },
      });
      try {
        expect(cp.port).toBeGreaterThan(0);
        expect(cp.baseUrl).toBe(`http://127.0.0.1:${cp.port}`);
        expect(
          (await fetch(`${cp.baseUrl}/api/v1/projects`, { headers: { host: "app.test" } })).status,
        ).toBe(401);
      } finally {
        await cp.stop();
        rmSync(cp.authDir, { recursive: true, force: true });
      }
    },
  );

  it("boots the actual local composition through an owned ephemeral public endpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-orb-actual-startup-"));
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    try {
      cp = await startControlPlane({
        port: 0,
        fake: { ...fake, inferenceBaseUrl: "http://127.0.0.1:1" },
        pglitePath: join(directory, "db"),
        processStateDirectory: join(directory, "hosts"),
        authDir: join(directory, "auth"),
        hostingRoot: join(directory, "hosting"),
      });
      expect(cp.port).toBeGreaterThan(0);
      expect((await fetch(`${cp.baseUrl}/api/v1/projects`)).status).toBe(200);
      const discovery = await fetch(`${cp.baseUrl}/.well-known/openid-configuration`);
      expect(discovery.status).toBe(200);
      const metadata = (await discovery.json()) as { issuer: string; jwks_uri: string };
      expect(metadata.issuer).toBe(cp.baseUrl);
      expect(new URL(metadata.issuer).port).not.toBe("0");
      expect(metadata.jwks_uri).toBe(`${cp.baseUrl}/.well-known/jwks.json`);
      await waitFor("public signing key publication", async () => {
        const response = await fetch(metadata.jwks_uri);
        if (response.status === 503) {
          expect(await response.json()).toEqual({
            error: "unavailable",
            message: "no signing keys published yet",
          });
          return null;
        }
        expect(response.status).toBe(200);
        return true;
      });
      const issuer = await fetchIssuerKeys(cp.baseUrl);
      expect(issuer.issuer).toBe(cp.baseUrl);
      expect(issuer.keys.length).toBeGreaterThan(0);
    } finally {
      await cp?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves public Host and a partial principal header through actual main readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-orb-principal-startup-"));
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    try {
      cp = await startControlPlane({
        port: 0,
        fake: { ...fake, inferenceBaseUrl: "http://127.0.0.1:1" },
        pglitePath: join(directory, "db"),
        processStateDirectory: join(directory, "hosts"),
        authDir: join(directory, "auth"),
        hostingRoot: join(directory, "hosting"),
        entry: "e2e/two-user-control-plane-entry.ts",
        readinessHeaders: { "x-pi-orb-e2e-principal": "alice" },
      });
      expect((await controlPlaneRequest(`${cp.baseUrl}/api/v1/projects`)).status).toBe(401);
      expect(
        (
          await controlPlaneRequest(`${cp.baseUrl}/api/v1/projects`, {
            headers: { "x-pi-orb-e2e-principal": "alice" },
          })
        ).status,
      ).toBe(200);
      expect(cp.logs.join("")).not.toContain("reason=unknown_host");
    } finally {
      await cp?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, "https://issuer.startup.test"])(
    "preserves configured public origin with issuer %s",
    async (configuredIssuer) => {
      const directory = mkdtempSync(join(tmpdir(), "pi-orb-custom-issuer-"));
      const appOrigin = "https://app.startup.test";
      const issuerOrigin = configuredIssuer ?? appOrigin;
      let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
      try {
        cp = await startControlPlane({
          port: 0,
          fake: { ...fake, inferenceBaseUrl: "http://127.0.0.1:1" },
          pglitePath: join(directory, "db"),
          processStateDirectory: join(directory, "hosts"),
          authDir: join(directory, "auth"),
          hostingRoot: join(directory, "hosting"),
          extraEnv: {
            PI_ORB_APP_ORIGIN: appOrigin,
            ...(configuredIssuer === undefined ? {} : { PI_ORB_OIDC_ISSUER_URL: configuredIssuer }),
          },
        });
        const response = await controlPlaneRequest(
          `${cp.baseUrl}/.well-known/openid-configuration`,
          {
            headers: { host: new URL(appOrigin).host },
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          issuer: issuerOrigin,
          jwks_uri: `${issuerOrigin}/.well-known/jwks.json`,
        });
      } finally {
        await cp?.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("kills the owned child and removes owned directories when readiness fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-orb-startup-test-"));
    const marker = join(directory, "child.json");
    try {
      await expect(
        startControlPlane({
          port: 0,
          fake,
          entry,
          extraEnv: { PI_ORB_E2E_STARTUP_MARKER: marker },
        }),
      ).rejects.toThrow("timed out waiting for control plane HTTP");
      const owned = JSON.parse(readFileSync(marker, "utf8")) as {
        pid: number;
        authDir: string;
        hostingRoot: string;
      };
      expect(() => process.kill(owned.pid, 0)).toThrow();
      expect(existsSync(owned.authDir)).toBe(false);
      expect(existsSync(owned.hostingRoot)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects an exited child before probing a possibly foreign server", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

    await expect(
      waitForOwnedControlPlane(child, logs, "http://127.0.0.1:1", 1_000),
    ).rejects.toThrow("exited before listening");
  }, 10_000);
});
