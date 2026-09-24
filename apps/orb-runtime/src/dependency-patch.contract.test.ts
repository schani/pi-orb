import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const json = (
  path: string,
): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} =>
  JSON.parse(read(path)) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

const piVersion = "0.87.1";
const patchPackageVersion = "8.0.1";
const patchPath = `patches/@earendil-works+pi-coding-agent+${piVersion}.patch`;

describe("Pi dependency patch installation", () => {
  it("pins the patched SDK and patch-package in every installing workspace", () => {
    expect(json("package.json").devDependencies?.["patch-package"]).toBe(patchPackageVersion);
    for (const manifest of ["apps/orb-runtime/package.json", "apps/control-plane/package.json"]) {
      expect(json(manifest).dependencies).toMatchObject({
        "@earendil-works/pi-coding-agent": piVersion,
        "patch-package": patchPackageVersion,
      });
    }
  });

  it("carries the exact versioned patch", () => {
    expect(existsSync(join(root, patchPath))).toBe(true);
    const patch = read(patchPath);
    expect(patch).toContain(
      "diff --git a/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
    );
    expect(patch).toContain("async _runCustomMessagePrompt(appMessage)");
  });

  it("applies the patch during root and both container installs", () => {
    expect(json("package.json").scripts?.postinstall).toMatch(/^patch-package && /);

    for (const [path, workspace] of [
      ["apps/orb-runtime/Dockerfile", "@pi-orb/orb-runtime"],
      ["apps/control-plane/Dockerfile", "@pi-orb/control-plane"],
    ] as const) {
      const dockerfile = read(path);
      const install = dockerfile.indexOf(`RUN npm ci --workspace ${workspace}`);
      expect(install).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY patches patches")).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY patches patches")).toBeLessThan(install);
      expect(dockerfile.indexOf("npx --no-install patch-package", install)).toBeGreaterThan(
        install,
      );
    }
  });

  it("applies the packaged patch during native-image installation", () => {
    expect(read("packages/native-image/src/snapshot.ts")).toMatch(
      /UPLOADED_SOURCE_PATHS = \[[\s\S]*"patches"/,
    );
    const nativeInstall = read("infra/native-vm/install.sh");
    expect(nativeInstall.indexOf("npx --no-install patch-package")).toBeGreaterThan(
      nativeInstall.indexOf("npm ci"),
    );
  });
});
