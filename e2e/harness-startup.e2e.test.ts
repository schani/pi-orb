import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startControlPlane, waitForOwnedControlPlane } from "./harness.ts";

const fake = {
  sessionKey: "unused",
  oauthBaseUrl: "https://unused.test",
  inferenceBaseUrl: "https://unused.test",
};
const entry = "e2e/testkit/control-plane-readiness-probe.ts";

describe("startControlPlane", () => {
  it("preserves exact public Host through owned ephemeral child and ingress listeners", async () => {
    const cp = await startControlPlane({
      port: 0,
      fake,
      entry,
      readinessPath: "/health",
      readinessHeaders: { host: "app.test" },
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
  });

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
    } finally {
      await cp?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
