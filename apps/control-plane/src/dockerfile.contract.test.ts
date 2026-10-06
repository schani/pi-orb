import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");
const controlPlanePackage = JSON.parse(
  readFileSync(join(repositoryRoot, "apps/control-plane/package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
  workspaces?: string[];
};
const dockerfile = readFileSync(join(repositoryRoot, "apps/control-plane/Dockerfile"), "utf8");

describe("control-plane Dockerfile workspace contract", () => {
  it("builds and smoke-tests Linux PTYs in a disposable dependency stage", () => {
    expect(controlPlanePackage.dependencies?.["node-pty"]).toBe("1.1.0");
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const dependencies = stages.find((stage) =>
      stage.startsWith("node:24-bookworm-slim AS dependencies\n"),
    );
    expect(dependencies).toBeDefined();
    expect(dependencies).toMatch(
      /apt-get install -y --no-install-recommends python3 build-essential/,
    );
    expect(dependencies).toContain("--ignore-scripts");
    expect(dependencies).toContain("rm -rf node_modules/node-pty/prebuilds");
    expect(dependencies).toContain("npm rebuild node-pty");
    expect(dependencies).toContain("require('node-pty')");
    expect(dependencies).toContain("pty.spawn('/bin/sh', ['-c', 'exit 0'])");
    const runtime = stages.at(-1) ?? "";
    expect(runtime).toContain("COPY --from=dependencies /app /app");
    expect(runtime).toContain("pty.spawn('/bin/sh', ['-c', 'exit 0'])");
    expect(runtime).not.toMatch(/build-essential|npm ci|npm rebuild/);
  });
  it("applies only installed package patches and retains code-mode attribution", () => {
    for (const name of ["pi-ai", "pi-coding-agent", "pi-codemode"]) {
      const patch = `@earendil-works+${name}+1.0.0.patch`;
      expect(dockerfile).toContain(`COPY patches/${patch} patches/${patch}`);
    }
    expect(dockerfile).toContain(
      "COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs",
    );
    expect(dockerfile).toContain("COPY patches/pi-codemode.* patches/");
    expect(dockerfile).not.toContain("COPY patches patches");
    expect(dockerfile).toContain("node scripts/apply-dependency-patches.mjs");
    expect(dockerfile).not.toContain("patch-package");
  });
  it("ships central Git acquisition, bundled skills and the code-mode worker", () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toContain("apt-get install -y --no-install-recommends git ca-certificates");
    expect(dockerfile).toContain("COPY apps/orb-runtime/skills apps/orb-runtime/skills");
    expect(dockerfile).toContain("COPY apps/control-plane/src apps/control-plane/src");
    expect(
      readFileSync(
        join(repositoryRoot, "apps/control-plane/src/adapters/durable/tools/bounded-worker.js"),
        "utf8",
      ),
    ).toContain("@earendil-works/pi-codemode");
  });
  it("ships the entry point's transitive static source imports in the final image", () => {
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const copies = [...finalStage.matchAll(/^COPY (?!-)(\S+) (\S+)$/gm)].map(
      ([, source = "", destination = ""]) => ({ source, destination }),
    );
    const pending = ["apps/control-plane/src/main.ts"];
    const visited = new Set<string>();
    const missing = new Set<string>();
    const undeclared = new Set<string>();
    for (const path of pending) {
      if (visited.has(path)) continue;
      visited.add(path);
      const copied = copies.some(({ source, destination }) => {
        const suffix = relative(source, path);
        return !suffix.startsWith("..") && join(destination, suffix) === path;
      });
      if (!copied) missing.add(path);

      // Erase type-only imports without loading modules or running bootstrap code.
      const source = stripTypeScriptTypes(readFileSync(join(repositoryRoot, path), "utf8"));
      const imports = source.matchAll(
        /\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g,
      );
      for (const [, specifier = ""] of imports) {
        if (specifier.startsWith(".")) {
          pending.push(join(dirname(path), specifier));
        } else if (path.startsWith("apps/orb-runtime/src/") && !specifier.startsWith("node:")) {
          const packageName = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : (specifier.split("/")[0] ?? specifier);
          if (controlPlanePackage.dependencies?.[packageName] === undefined) {
            undeclared.add(`${path}: ${packageName}`);
          }
        }
      }
    }
    expect([...missing].sort(), "static source imports missing from the final image").toEqual([]);
    expect([...undeclared].sort(), "shared helpers need control-plane dependencies").toEqual([]);
  });

  it("copies every local control-plane dependency's package metadata and source", () => {
    const workspacePaths = rootPackage.workspaces ?? [];
    const localPackages = new Map<string, string>();
    for (const workspacePath of workspacePaths) {
      const packageJsonPath = join(repositoryRoot, workspacePath, "package.json");
      let parsed: { name?: string };
      try {
        parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
      } catch {
        continue;
      }
      if (parsed.name !== undefined) localPackages.set(parsed.name, workspacePath);
    }

    const controlPlaneDependencies = Object.keys(controlPlanePackage.dependencies ?? {});
    for (const dependency of controlPlaneDependencies) {
      const workspacePath = localPackages.get(dependency);
      if (workspacePath === undefined) continue;
      expect(dockerfile, `${dependency} package.json must be copied before npm ci`).toContain(
        `COPY ${workspacePath}/package.json ${workspacePath}/`,
      );
      expect(
        dockerfile,
        `${dependency} source must be copied into the control-plane image`,
      ).toContain(`COPY ${workspacePath}/src ${workspacePath}/src`);
    }
  });
});
