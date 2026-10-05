import { createHash } from "node:crypto";
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
const runner = "scripts/apply-dependency-patches.mjs";
const patchPath = `patches/@earendil-works+pi-coding-agent+${piVersion}.patch`;

describe("Pi dependency patch installation", () => {
  it("pins the patched SDK without patch-package in every installing workspace", () => {
    expect(json("package.json").devDependencies).not.toHaveProperty("patch-package");
    for (const manifest of ["apps/orb-runtime/package.json", "apps/control-plane/package.json"]) {
      expect(json(manifest).dependencies).toMatchObject({
        "@earendil-works/pi-coding-agent":
          "file:../../vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz",
      });
      expect(json(manifest).dependencies).not.toHaveProperty("patch-package");
    }
  });

  it("removes the vulnerable installer chain from the production lock", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, unknown>;
    };
    for (const name of ["patch-package", "find-yarn-workspace-root", "micromatch", "braces"])
      expect(
        Object.keys(lock.packages).filter(
          (path) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`,
        ),
      ).toEqual([]);
  });

  it("preserves the exact vendor SDK archive", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(join(root, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz")))
        .digest("hex"),
    ).toBe("eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509");
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
    expect(json("package.json").scripts?.postinstall).toBe(
      `node ${runner} && node scripts/fix-node-pty-prebuild-permissions.mjs`,
    );

    for (const [path, workspace] of [
      ["apps/orb-runtime/Dockerfile", "@pi-orb/orb-runtime"],
      ["apps/control-plane/Dockerfile", "@pi-orb/control-plane"],
    ] as const) {
      const dockerfile = read(path);
      const install = dockerfile.indexOf(`RUN npm ci --workspace ${workspace}`);
      expect(install).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY vendor vendor")).toBeGreaterThan(-1);
      expect(dockerfile.indexOf("COPY vendor vendor")).toBeLessThan(install);
      expect(dockerfile.indexOf(`node ${runner}`, install)).toBeGreaterThan(install);
      expect(dockerfile.indexOf(`COPY ${runner} ${runner}`)).toBeGreaterThan(-1);
      expect(dockerfile.indexOf(`COPY ${runner} ${runner}`)).toBeLessThan(install);
      expect(dockerfile.indexOf("apt-get install -y --no-install-recommends git")).toBeGreaterThan(
        -1,
      );
      expect(dockerfile.indexOf("apt-get install -y --no-install-recommends git")).toBeLessThan(
        install,
      );
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
    expect(read("packages/native-image/src/snapshot.ts")).toContain(`"${runner}"`);
    expect(nativeInstall.indexOf(`node ${runner}`)).toBeGreaterThan(
      nativeInstall.indexOf("npm ci"),
    );
  });
});
