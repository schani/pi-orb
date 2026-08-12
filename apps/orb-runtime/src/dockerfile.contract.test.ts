import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");
const runtimePackage = JSON.parse(
  readFileSync(join(repositoryRoot, "apps/orb-runtime/package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
  workspaces?: string[];
};
const dockerfile = readFileSync(join(repositoryRoot, "apps/orb-runtime/Dockerfile"), "utf8");

describe("orb runtime Dockerfile contract", () => {
  it("installs the prescribed Python environment", () => {
    expect(dockerfile).toContain("python3");
    expect(dockerfile).toContain("python3-venv");
    expect(dockerfile).toContain("python-is-python3");
  });

  it("installs zip archive tools", () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bzip\b[^\n]*\bunzip\b/);
  });

  it("installs agent-browser with a system Chromium executable", () => {
    expect(runtimePackage.dependencies?.["agent-browser"]).toBe("0.33.2");
    expect(dockerfile).toContain("gh tailscale chromium");
    expect(dockerfile).toContain(
      "ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser",
    );
  });

  it("installs rustup and native build prerequisites with persistent Rust state", () => {
    expect(dockerfile).toContain("build-essential");
    expect(dockerfile).toContain("pkg-config");
    expect(dockerfile).toContain("rustup/archive/1.29.0");
    expect(dockerfile).toContain("sha256sum --check");
    expect(dockerfile).toContain("ENV RUSTUP_HOME=/workspace/home/.rustup");
    expect(dockerfile).toContain("ENV CARGO_HOME=/workspace/home/.cargo");
  });

  it("builds the node-pty Linux addon while keeping other lifecycle scripts disabled", () => {
    expect(dockerfile).toContain("--ignore-scripts");
    expect(dockerfile).toContain("rm -rf node_modules/node-pty/prebuilds");
    expect(dockerfile).toContain("npm rebuild node-pty");
  });

  it("declares HOME on the persistent orb volume", () => {
    expect(dockerfile).toContain("ENV HOME=/workspace/home");
    expect(dockerfile).toContain("VOLUME /workspace");
  });

  it("copies every local runtime dependency's package metadata and source", () => {
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

    const runtimeDependencies = Object.keys(runtimePackage.dependencies ?? {});
    for (const dependency of runtimeDependencies) {
      const workspacePath = localPackages.get(dependency);
      if (workspacePath === undefined) continue;
      expect(dockerfile, `${dependency} package.json must be copied before npm ci`).toContain(
        `COPY ${workspacePath}/package.json ${workspacePath}/`,
      );
      expect(dockerfile, `${dependency} source must be copied into the runtime image`).toContain(
        `COPY ${workspacePath}/src ${workspacePath}/src`,
      );
    }
  });
});
