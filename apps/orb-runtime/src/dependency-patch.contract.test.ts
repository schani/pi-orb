import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

const piVersion = "1.0.0";
const patchPackageVersion = "8.0.1";
const patchPath = `patches/@earendil-works+pi-coding-agent+${piVersion}.patch`;

describe("Pi dependency patch installation", () => {
  it("pins the patched SDK and patch-package in every installing workspace", () => {
    expect(json("package.json").devDependencies?.["patch-package"]).toBe(patchPackageVersion);
    for (const manifest of ["apps/orb-runtime/package.json", "apps/control-plane/package.json"]) {
      expect(json(manifest).dependencies).toMatchObject({
        "@earendil-works/pi-coding-agent":
          "file:../../vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz",
        "patch-package": patchPackageVersion,
      });
    }
  });

  it("installs the patched brace expansion despite Pi's bundled shrinkwrap", () => {
    const fromPi = createRequire(
      join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    );
    const installed = JSON.parse(
      readFileSync(fromPi.resolve("brace-expansion/package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe("5.0.12");
  });

  it("carries the exact versioned patch", () => {
    expect(existsSync(join(root, patchPath))).toBe(true);
    const patch = read(patchPath);
    expect(patch).toContain(
      "diff --git a/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
    );
    expect(patch).toContain("async _runCustomMessagePrompt(appMessage)");
  });

  it("applies exactly the installed patches during root and container installs", () => {
    expect(json("package.json").scripts?.postinstall).toMatch(/^patch-package --error-on-fail && /);

    for (const [path, workspace] of [
      ["apps/orb-runtime/Dockerfile", "@pi-orb/orb-runtime"],
      ["apps/control-plane/Dockerfile", "@pi-orb/control-plane"],
    ] as const) {
      const dockerfile = read(path);
      const install = dockerfile.indexOf(`RUN npm ci --workspace ${workspace}`);
      expect(install).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY vendor vendor")).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY vendor vendor")).toBeLessThan(install);
      expect(
        dockerfile.indexOf("npx --no-install patch-package --error-on-fail", install),
      ).toBeGreaterThan(install);
    }

    const patchFiles = [
      "@earendil-works+pi-ai+1.0.0.patch",
      "@earendil-works+pi-coding-agent+1.0.0.patch",
      "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
    ];
    expect(readdirSync(join(root, "patches")).sort()).toEqual([...patchFiles].sort());
    const controlPlaneDependencies = json("apps/control-plane/package.json").dependencies;
    expect(controlPlaneDependencies?.["@earendil-works/pi-ai"]).toBe(piVersion);
    expect(controlPlaneDependencies?.["@gotgenes/pi-subagents"]).toBeUndefined();
    const controlPlane = read("apps/control-plane/Dockerfile");
    const install = controlPlane.indexOf("RUN npm ci --workspace @pi-orb/control-plane");
    expect(controlPlane).not.toContain("COPY patches patches");
    for (const patch of patchFiles) {
      const copy = `COPY patches/${patch} patches/${patch}`;
      if (patch.startsWith("@gotgenes+")) {
        expect(controlPlane).not.toContain(copy);
      } else {
        expect(controlPlane.indexOf(copy)).toBeGreaterThan(-1);
        expect(controlPlane.indexOf(copy)).toBeLessThan(install);
      }
    }
    const runtime = read("apps/orb-runtime/Dockerfile");
    expect(runtime.indexOf("COPY patches patches")).toBeGreaterThan(-1);
    expect(runtime.indexOf("COPY patches patches")).toBeLessThan(
      runtime.indexOf("RUN npm ci --workspace @pi-orb/orb-runtime"),
    );
  });

  it("applies the packaged patch during native-image installation", () => {
    expect(read("packages/native-image/src/snapshot.ts")).toMatch(
      /UPLOADED_SOURCE_PATHS = \[[\s\S]*"patches"/,
    );
    const nativeInstall = read("infra/native-vm/install.sh");
    expect(nativeInstall.indexOf("npx --no-install patch-package --error-on-fail")).toBeGreaterThan(
      nativeInstall.indexOf("npm ci"),
    );
  });
});
