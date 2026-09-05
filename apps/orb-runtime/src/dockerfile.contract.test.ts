import { existsSync, readFileSync } from "node:fs";
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

  it("installs sudo so Amp-style boot hooks run unchanged", () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bsudo\b/);
  });

  it("marks every process in the orb with PI_ORB=1 and never sets AMP_ORB", () => {
    expect(dockerfile).toMatch(/^ENV PI_ORB=1$/m);
    expect(dockerfile).not.toMatch(/^ENV AMP_ORB/m);
  });

  it("installs agent-browser with a system Chromium executable", () => {
    expect(runtimePackage.dependencies?.["agent-browser"]).toBe("0.33.2");
    expect(dockerfile).toContain("gh tailscale chromium");
    expect(dockerfile).toContain(
      "ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser",
    );
  });

  it("installs the Google Cloud CLI from Google's apt repository", () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bgoogle-cloud-cli\b/);
    expect(dockerfile).toContain(
      "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt cloud-sdk main",
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

  it("installs every in-orb shim as an executable on PATH", () => {
    // The three point-of-use helpers of docs/credentials.md and
    // docs/workload-identity.md: an image that ships the source but not the
    // shim leaves `gh`, git pushes, or `pi-orb id-token` broken inside the orb.
    const shims = ["gh", "pi-orb-git-credential", "pi-orb"];
    for (const shim of shims) {
      expect(existsSync(join(repositoryRoot, "apps/orb-runtime/docker", shim))).toBe(true);
      expect(dockerfile).toContain(`COPY apps/orb-runtime/docker/${shim} /usr/local/bin/${shim}`);
    }
    // Split into whole arguments before matching: `/usr/local/bin/pi-orb` is a
    // prefix of `/usr/local/bin/pi-orb-git-credential`, so a substring check
    // would call the `pi-orb` shim executable on the strength of a different
    // shim's chmod.
    const chmod = /RUN chmod 755 ([^\n\\]*)/.exec(dockerfile)?.[1] ?? "";
    const chmodTargets = chmod.trim().split(/\s+/);
    for (const shim of shims) {
      expect(chmodTargets, `${shim} must be made executable`).toContain(`/usr/local/bin/${shim}`);
    }
    // Each shim dispatches to source the image actually carries.
    const piOrbShim = readFileSync(join(repositoryRoot, "apps/orb-runtime/docker/pi-orb"), "utf8");
    expect(piOrbShim).toContain("apps/orb-runtime/src/id-token/cli.ts");
    expect(piOrbShim).toContain("apps/orb-runtime/src/inspection/cli.ts");
    expect(piOrbShim).toContain("orbs|transcript");
    expect(piOrbShim).toContain("apps/orb-runtime/src/archive/cli.ts");
    expect(existsSync(join(repositoryRoot, "apps/orb-runtime/src/archive/cli.ts"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "apps/orb-runtime/src/id-token/cli.ts"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "apps/orb-runtime/src/inspection/cli.ts"))).toBe(true);
    // Every shim resolves its entry point from its own location, so the same
    // file works at /usr/local/bin in the image and in place on a process
    // host, where the repository copy is on PATH.
    const credentialShim = readFileSync(
      join(repositoryRoot, "apps/orb-runtime/docker/pi-orb-git-credential"),
      "utf8",
    );
    const ghShim = readFileSync(join(repositoryRoot, "apps/orb-runtime/docker/gh"), "utf8");
    for (const shim of [piOrbShim, credentialShim, ghShim]) {
      expect(shim).toContain('script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)');
      expect(shim).toContain('if [ "$script_dir" = /usr/local/bin ]');
    }
    expect(credentialShim).toContain("apps/orb-runtime/src/gh/cli.ts");
    expect(ghShim).toContain("apps/orb-runtime/src/gh/cli.ts");
    expect(existsSync(join(repositoryRoot, "apps/orb-runtime/src/gh/cli.ts"))).toBe(true);
  });

  it("installs the reviewed Google executable credential source", () => {
    // The `cloud-identity` skill tells the agent to point an external-account
    // credential file at this absolute path (docs/workload-identity-recipes.md).
    // Without it the agent's only alternative is writing its own credential
    // helper, which is exactly what "no unreviewed credential helper" forbids.
    expect(existsSync(join(repositoryRoot, "scripts/pi-orb-gcp-identity"))).toBe(true);
    expect(dockerfile).toContain(
      "COPY scripts/pi-orb-gcp-identity /usr/local/bin/pi-orb-gcp-identity",
    );
    const chmod = /RUN chmod 755 ([^\n\\]*)/.exec(dockerfile)?.[1] ?? "";
    expect(chmod.trim().split(/\s+/)).toContain("/usr/local/bin/pi-orb-gcp-identity");
  });

  it("bakes the agent skills outside the persistent volume", () => {
    // /workspace is a VOLUME: anything the image places under it is shadowed
    // by the orb's persistent filesystem at runtime, so the skills must live
    // elsewhere. `BAKED_SKILLS_DIR` in the resource loader is the other half.
    expect(dockerfile).toContain("COPY apps/orb-runtime/skills /opt/pi-orb/skills");
    expect(
      existsSync(join(repositoryRoot, "apps/orb-runtime/skills/cloud-identity/SKILL.md")),
    ).toBe(true);
    expect(dockerfile).not.toContain("/workspace/skills");
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
