import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configurePersistentHome, persistentHomePath } from "./home.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent orb home", () => {
  it("creates a private home under the orb work directory and exports it", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-orb-home-"));
    roots.push(workDir);
    const environment: NodeJS.ProcessEnv = { HOME: "/shared-host-home" };

    const result = configurePersistentHome(workDir, environment);

    expect(result.isOk()).toBe(true);
    const home = persistentHomePath(workDir);
    expect(result.unwrapOr("")).toBe(home);
    expect(environment.HOME).toBe(home);
    expect(statSync(home).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("repairs permissive permissions on an existing home", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-orb-home-"));
    roots.push(workDir);
    const home = persistentHomePath(workDir);
    mkdirSync(home, { mode: 0o755 });

    const result = configurePersistentHome(workDir, {});

    expect(result.isOk()).toBe(true);
    if (process.platform !== "win32") expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});
