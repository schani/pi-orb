import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const fromPatch = createRequire(join(root, "node_modules/patch-package/package.json"));
const finderPath = fromPatch.resolve("./dist/findWorkspaceRoot.js");
const finder = fromPatch("./dist/findWorkspaceRoot.js") as (
  initial?: string | null,
) => string | null;
const fixtures: string[] = [];
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function fixture(workspaces?: unknown): string {
  const path = mkdtempSync(join(tmpdir(), "pi-orb-workspace-root-"));
  fixtures.push(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ workspaces }));
  return path;
}

function directory(root: string, path: string): string {
  const result = join(root, path);
  mkdirSync(result, { recursive: true });
  return result;
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("shipped patch-package workspace discovery", () => {
  it("removes the braces chain at its only dependency owner", () => {
    const manifest = readJson(join(dirname(finderPath), "../package.json"));
    expect(manifest.version).toBe("8.0.1-orb.1");
    expect(manifest.dependencies.picomatch).toBe("2.3.2");
    expect(manifest.dependencies["find-yarn-workspace-root"]).toBeUndefined();
    const lock = readJson(join(root, "package-lock.json"));
    for (const path of Object.keys(lock.packages)) {
      expect(path).not.toMatch(/node_modules\/(braces|micromatch|find-yarn-workspace-root)$/);
    }
    expect(readJson(join(root, "package.json")).overrides).toBeUndefined();
  });

  it("ships a prominent modification notice with the Apache-licensed finder", () => {
    expect(readFileSync(finderPath, "utf8").split("\n")[2]).toBe(
      "// Modified by pi-orb: replace micromatch with its primary matcher using picomatch.",
    );
  });

  it("packages the pinned tool in every standalone archive recipe and guard", () => {
    for (const name of ["stage", "iap-read", "glideos-read"]) {
      for (const role of ["package", "guard"]) {
        expect(
          readFileSync(
            join(root, `scripts/native-mcp-exploration/live-qualification/${name}-${role}.mjs`),
            "utf8",
          ),
        ).toContain("patch-package-8.0.1-orb.1.tgz");
      }
    }
    const standalone = readJson(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
    );
    expect(standalone.packages["node_modules/patch-package"].version).toBe("8.0.1-orb.1");
    for (const path of Object.keys(standalone.packages)) {
      expect(path).not.toMatch(/node_modules\/(braces|micromatch|find-yarn-workspace-root)$/);
    }
  });

  for (const format of ["array", "packages"] as const) {
    it(`discovers ${format} workspaces and preserves root short-circuit`, () => {
      const patterns = ["apps/*"];
      const path = fixture(format === "array" ? patterns : { packages: patterns, nohoist: ["*"] });
      expect(finder(directory(path, "apps/keep"))).toBe(path);
      expect(finder(directory(path, "other/keep"))).toBeNull();
      expect(finder(path)).toBe(path);
      const empty = fixture([]);
      expect(finder(empty)).toBe(empty);
      expect(finder(directory(empty, "apps/keep"))).toBeNull();
    });
  }

  for (const [patterns, relative, accepted] of [
    [["apps/*", "!apps/skip"], "apps/keep", true],
    [["apps/*", "!apps/skip"], "apps/skip", false],
    [["!apps/skip"], "apps/keep", true],
    [["!apps/skip"], "apps/skip", false],
    [["!apps/*", "apps/keep"], "apps/keep", true],
    [["apps/keep", "!apps/*"], "apps/keep", false],
    [["apps/!(skip)"], "apps/keep", true],
    [["apps/!(skip)"], "apps/skip", false],
    [["apps/{keep,other}"], "apps/keep", true],
    [["apps/{keep,other}"], "apps/skip", false],
    [["apps/item{1..3}"], "apps/item2", true],
    [["apps/item{1..3}"], "apps/item4", false],
    [["apps/**/keep"], "apps/deep/keep", true],
    [["apps/*"], "apps/deep/keep", false],
    [["apps/*"], "apps/.hidden", false],
    [[String.raw`apps/a\[1\]`], "apps/a[1]", true],
    [[String.raw`apps/a\?b`], "apps/a?b", true],
    [[String.raw`apps/\{literal\}`], "apps/{literal}", true],
    [["apps/[ab]"], "apps/a", true],
    [["apps/[ab]"], "apps/c", false],
    [["apps/+([ab])"], "apps/ab", true],
    [["apps/+([ab])"], "apps/c", false],
    [["apps/*"], "apps/line\nbreak", true],
    [["apps/line?break"], "apps/line\nbreak", true],
    [[String.raw`apps\keep`], "apps/keep", false],
    [[String.raw`apps\\keep`], String.raw`apps\keep`, true],
    [[String.raw`apps/back\\slash`], String.raw`apps/back\slash`, true],
  ] as const) {
    it(`${accepted ? "accepts" : "rejects"} ${relative} against ${patterns.join(",")}`, () => {
      const path = fixture(patterns);
      expect(finder(directory(path, relative))).toBe(accepted ? path : null);
    });
  }

  it("stops at the nearest workspace manifest even if an outer root would match", () => {
    const path = fixture(["apps/**"]);
    const nested = directory(path, "apps/nested");
    writeFileSync(join(nested, "package.json"), JSON.stringify({ workspaces: ["members/*"] }));
    expect(finder(directory(nested, "members/keep"))).toBe(nested);
    expect(finder(directory(nested, "other/keep"))).toBeNull();
    expect(finder(nested)).toBe(nested);
  });

  it("passes ordinary package manifests and normalizes traversal and trailing separators", () => {
    const path = fixture(["apps/*"]);
    const keep = directory(path, "apps/keep");
    writeFileSync(join(keep, "package.json"), "{}");
    expect(finder(`${keep}/../keep/`)).toBe(path);
    expect(finder(directory(path, "elsewhere/../apps/keep"))).toBe(path);
    const outside = fixture(["other/*"]);
    expect(finder(directory(outside, "apps/keep"))).toBeNull();
  });

  it("preserves omitted/null initial directory without mutating the test process cwd", () => {
    const path = fixture(["apps/*"]);
    const cwd = directory(path, "apps/keep");
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const find = require(${JSON.stringify(finderPath)});
      console.log(JSON.stringify([find(), find(null)]));
    `,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([path, path]);
  });

  it("uses the embedded finder in package-manager detection and retains npm precedence", () => {
    const path = fixture({ packages: ["apps/*"] });
    writeFileSync(join(path, "yarn.lock"), "# yarn lockfile v1\n");
    const cwd = directory(path, "apps/keep");
    writeFileSync(join(cwd, "package.json"), "{}");
    const detectionPath = fromPatch.resolve("./dist/detectPackageManager.js");
    const detect = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            `
      const { detectPackageManager } = require(${JSON.stringify(detectionPath)});
      console.log(JSON.stringify(detectPackageManager(process.cwd(), null)));
    `,
          ],
          { cwd, encoding: "utf8" },
        ),
      );
    expect(detect()).toBe("yarn");
    writeFileSync(join(cwd, "package-lock.json"), "{}");
    expect(detect()).toBe("npm");
  });

  it("resolves Yarn packages through the discovered ancestor lock", () => {
    const path = fixture(["apps/*"]);
    writeFileSync(
      join(path, "yarn.lock"),
      '# yarn lockfile v1\n\nfixture-dependency@^1.0.0:\n  version "1.0.0"\n  resolved "https://example.invalid/fixture-dependency-1.0.0.tgz"\n',
    );
    const cwd = directory(path, "apps/keep");
    const installed = directory(cwd, "node_modules/fixture-dependency");
    writeFileSync(join(installed, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const resolutionPath = fromPatch.resolve("./dist/getPackageResolution.js");
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const { getPackageResolution } = require(${JSON.stringify(resolutionPath)});
      console.log(JSON.stringify(getPackageResolution({
        packageDetails: { name: "fixture-dependency", path: "node_modules/fixture-dependency", pathSpecifier: "fixture-dependency" },
        packageManager: "yarn", appPath: process.cwd()
      })));
    `,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toBe("https://example.invalid/fixture-dependency-1.0.0.tgz");
  });

  it("applies patches idempotently and fails incompatible or missing dependencies", () => {
    const path = fixture();
    directory(path, "patches");
    const installed = directory(path, "node_modules/fixture-dependency");
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
    );
    writeFileSync(join(installed, "index.js"), "original\n");
    writeFileSync(
      join(path, "patches/fixture-dependency+1.0.0.patch"),
      [
        "diff --git a/node_modules/fixture-dependency/index.js b/node_modules/fixture-dependency/index.js",
        "--- a/node_modules/fixture-dependency/index.js",
        "+++ b/node_modules/fixture-dependency/index.js",
        "@@ -1 +1 @@",
        "-original",
        "+patched",
        "",
      ].join("\n"),
    );
    const apply = () =>
      spawnSync(process.execPath, [fromPatch.resolve("patch-package"), "--error-on-fail"], {
        cwd: path,
        encoding: "utf8",
      });
    expect(apply().status).toBe(0);
    expect(readFileSync(join(installed, "index.js"), "utf8")).toBe("patched\n");
    expect(apply().status).toBe(0);
    writeFileSync(join(installed, "index.js"), "incompatible\n");
    const incompatible = apply();
    expect(incompatible.status).toBe(1);
    expect(incompatible.stdout).toContain("Failed to apply patch");
    rmSync(installed, { recursive: true });
    const missing = apply();
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("not present");
  });

  it("does not load braces or micromatch while discovering a deeply nested pattern", () => {
    const path = fixture([`apps/${"{".repeat(5000)}keep${"}".repeat(5000)}`]);
    const cwd = directory(path, "apps/keep");
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const find = require(${JSON.stringify(finderPath)});
      find(process.cwd());
      console.log(JSON.stringify(Object.keys(require.cache).filter(
        path => /node_modules\\/(braces|micromatch)\\//.test(path)
      )));
    `,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([]);
  });
});
