import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const helper = join(root, "scripts/apply-dependency-patches.mjs");
const names = [
  "@earendil-works+pi-ai+1.0.0.patch",
  "@earendil-works+pi-coding-agent+1.0.0.patch",
  "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
];
const scratch: string[] = [];
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = (name: string) =>
  [
    ...readFileSync(join(root, "patches", name), "utf8").matchAll(/^diff --git a\/(\S+) b\/\S+$/gm),
  ].map((match) => match[1] as string);
const runWithEnv = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, [join(cwd, "scripts/apply-dependency-patches.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", ...env },
  });
const run = (cwd: string, ...args: string[]) => runWithEnv(cwd, {}, ...args);
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
};
const assertPatched = (dir: string) => {
  for (const name of names)
    for (const path of files(name)) expect(sha(join(dir, path))).toBe(sha(join(root, path)));
};
function fixture(patched = false) {
  const dir = mkdtempSync(join(tmpdir(), "dependency-patches-"));
  scratch.push(dir);
  mkdirSync(join(dir, "patches"));
  mkdirSync(join(dir, "scripts"));
  cpSync(helper, join(dir, "scripts/apply-dependency-patches.mjs"));
  cpSync(join(root, "node_modules/neverthrow"), join(dir, "node_modules/neverthrow"), {
    recursive: true,
  });
  for (const name of names) {
    cpSync(join(root, "patches", name), join(dir, "patches", name));
    const targets = files(name);
    const packagePath = targets[0]?.split("/").slice(0, 3).join("/") as string;
    const manifest = join(packagePath, "package.json");
    for (const path of [...targets, manifest]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(root, path), join(dir, path));
    }
    if (!patched) {
      const reverse = spawnSync("git", ["apply", "--reverse", "--", join(dir, "patches", name)], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(reverse.status, reverse.stderr).toBe(0);
    }
  }
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sealed dependency patch application", () => {
  it("applies clean packages and leaves exact patched bytes on repeated application", () => {
    const dir = fixture();
    expect(run(dir).status).toBe(0);
    for (const name of names)
      for (const path of files(name)) expect(sha(join(dir, path))).toBe(sha(join(root, path)));
    expect(run(dir).status).toBe(0);
  });
  it.each(["root", "nested"])("applies and reapplies inside a Git repository (%s)", (location) => {
    const dir = fixture();
    git(dir, "init", "--quiet");
    const configBefore = sha(join(dir, ".git/config"));
    let install = dir;
    if (location === "nested") {
      install = join(dir, ".context/staging");
      mkdirSync(install, { recursive: true });
      for (const path of ["node_modules", "patches", "scripts"])
        renameSync(join(dir, path), join(install, path));
    }
    const first = run(install);
    expect(first.status, first.stderr).toBe(0);
    assertPatched(install);
    const again = run(install);
    expect(again.status, again.stderr).toBe(0);
    assertPatched(install);
    expect(sha(join(dir, ".git/config"))).toBe(configBefore);
    expect(existsSync(join(dir, ".git/index"))).toBe(false);
    if (location === "nested") expect(existsSync(join(install, ".git"))).toBe(false);
  });
  it.each(["outside", "nested", "missing-context"])(
    "isolates inherited external Git context (%s)",
    (location) => {
      const external = fixture();
      git(external, "init", "--quiet");
      writeFileSync(join(external, "sentinel"), "external worktree\n");
      git(external, "add", "sentinel");
      const dir = fixture();
      let install = dir;
      if (location === "nested") {
        git(dir, "init", "--quiet");
        install = join(dir, ".context/staging");
        mkdirSync(install, { recursive: true });
        for (const path of ["node_modules", "patches", "scripts"])
          renameSync(join(dir, path), join(install, path));
      }
      const guarded = [".git/config", ".git/index", "sentinel", ...names.flatMap(files)];
      const before = guarded.map((path) => sha(join(external, path)));
      const env = {
        GIT_DIR: join(external, location === "missing-context" ? ".missing-git" : ".git"),
        GIT_COMMON_DIR: join(external, ".git"),
        GIT_WORK_TREE: external,
        GIT_INDEX_FILE: join(external, ".git/index"),
        GIT_OBJECT_DIRECTORY: join(external, ".git/objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(external, ".git/objects"),
        GIT_PREFIX: "unrelated/",
        GIT_IMPLICIT_WORK_TREE: "1",
        GIT_CEILING_DIRECTORIES: "/",
        GIT_CONFIG_PARAMETERS:
          location === "missing-context" ? "invalid inherited config" : "'core.abbrev=12'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.abbrev",
        GIT_CONFIG_VALUE_0: "12",
      };
      const first = runWithEnv(install, env);
      expect(first.status, first.stderr).toBe(0);
      assertPatched(install);
      const again = runWithEnv(install, env);
      expect(again.status, again.stderr).toBe(0);
      assertPatched(install);
      expect(guarded.map((path) => sha(join(external, path)))).toEqual(before);
      expect(existsSync(join(install, ".git"))).toBe(false);
      if (location === "nested") expect(existsSync(join(dir, ".git/index"))).toBe(false);
    },
  );
  it("rejects the wrong installed version before touching another package", () => {
    const dir = fixture();
    const target = join(dir, files(names[0] as string)[0] as string);
    const before = sha(target);
    const manifest = join(dir, "node_modules/@gotgenes/pi-subagents/package.json");
    writeFileSync(manifest, JSON.stringify({ version: "21.7.1" }));
    expect(run(dir).status).toBe(1);
    expect(sha(target)).toBe(before);
  });
  it.each(["package", "patch", "file"])("rejects a missing %s", (kind) => {
    const dir = fixture();
    const path =
      kind === "package"
        ? "node_modules/@earendil-works/pi-ai/package.json"
        : kind === "patch"
          ? `patches/${names[0]}`
          : (files(names[0] as string)[0] as string);
    rmSync(join(dir, path));
    expect(run(dir).status).toBe(1);
  });
  it("rejects malformed or substituted patch bytes", () => {
    const dir = fixture();
    writeFileSync(join(dir, "patches", names[0] as string), "not a patch\n");
    expect(run(dir).status).toBe(1);
  });
  it.each([false, true])("rejects altered bytes outside hunks (patched=%s)", (patched) => {
    const dir = fixture(patched);
    const path = join(dir, files(names[0] as string)[0] as string);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// changed\n`);
    expect(run(dir).status).toBe(1);
  });
  it("rejects a partially patched package", () => {
    const dir = fixture();
    const path = files(names[1] as string)[0] as string;
    cpSync(join(root, path), join(dir, path));
    expect(run(dir).status).toBe(1);
  });
  it("pi-only installs require both Pi packages but not subagents", () => {
    const dir = fixture();
    rmSync(join(dir, "node_modules/@gotgenes"), { recursive: true });
    rmSync(join(dir, "patches", names[2] as string));
    expect(run(dir, "--pi-only").status).toBe(0);
    expect(run(dir).status).toBe(1);
  });
  it("rejects unknown scopes", () => {
    expect(run(fixture(), "--ignore-missing").status).toBe(1);
  });
  it("fails visibly when Git is unavailable without changing package bytes", () => {
    const dir = fixture();
    const target = join(dir, files(names[0] as string)[0] as string);
    const before = sha(target);
    const result = spawnSync(
      process.execPath,
      [join(dir, "scripts/apply-dependency-patches.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: "", NODE_OPTIONS: "" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("patch check failed");
    expect(sha(target)).toBe(before);
  });
  it("preserves every vendor archive and shipped patch checksum", () => {
    const evidence = `d9afae712be5304e09a490f28b0493180c8565fe6585efe173b1daaab3e5cf2a  vendor/gotgenes-pi-subagents-21.7.0-orb.8.tgz
 eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509  vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz
 e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830  patches/@earendil-works+pi-ai+1.0.0.patch
 c684fe6a6a57426521a6fd822ced3636f2004b29eebff3af489e84f59f84c0cf  patches/@earendil-works+pi-coding-agent+1.0.0.patch
 adcb859f8c0a0348ae7c745f16f35d2715e948f36542196b3b9c1c7c7c7bf571  patches/@gotgenes+pi-subagents+21.7.0-orb.8.patch`;
    for (const line of evidence.trim().split("\n")) {
      const [hash, path] = line.trim().split(/\s+/);
      expect(sha(join(root, path as string))).toBe(hash);
    }
  });
});
