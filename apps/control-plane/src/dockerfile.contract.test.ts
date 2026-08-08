import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      expect(dockerfile, `${dependency} source must be copied into the control-plane image`).toContain(
        `COPY ${workspacePath}/src ${workspacePath}/src`,
      );
    }
  });
});
