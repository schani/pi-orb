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
  "@earendil-works+pi-ai+1.4.0.patch",
  "@earendil-works+pi-coding-agent+1.4.0.patch",
  "@earendil-works+pi-codemode+1.4.0.patch",
  "@earendil-works+pi-durable+1.4.0.patch",
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
    const manifest = join(dir, "node_modules/@earendil-works/pi-durable/package.json");
    writeFileSync(manifest, JSON.stringify({ version: "1.3.1" }));
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
  it.each(["package", "patch", "file"])(
    "requires Durable %s before changing any package",
    (kind) => {
      const dir = fixture();
      const path =
        kind === "package"
          ? "node_modules/@earendil-works/pi-durable/package.json"
          : kind === "patch"
            ? "patches/@earendil-works+pi-durable+1.4.0.patch"
            : "node_modules/@earendil-works/pi-durable/dist/codemode/index.js";
      const target = join(dir, files(names[0] as string)[0] as string);
      const before = sha(target);
      rmSync(join(dir, path));
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("input_unreadable");
      expect(sha(target)).toBe(before);
      expect(run(dir).status).toBe(1);
      expect(sha(target)).toBe(before);
    },
  );
  it("installs from the control-plane Docker patch COPY inputs without Docker", () => {
    const dir = fixture();
    rmSync(join(dir, "patches"), { recursive: true });
    mkdirSync(join(dir, "patches"));
    const dockerfile = readFileSync(join(root, "apps/control-plane/Dockerfile"), "utf8");
    const inputs = [...dockerfile.matchAll(/^COPY patches\/(\S+) patches\/\1$/gm)].map(
      (match) => match[1] as string,
    );
    expect(inputs.sort()).toEqual(names.toSorted());
    for (const name of inputs) cpSync(join(root, "patches", name), join(dir, "patches", name));
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    for (const name of inputs)
      for (const path of files(name)) expect(sha(join(dir, path))).toBe(sha(join(root, path)));
  });
  it.each(names)("rejects changed patch bytes: %s", (name) => {
    const dir = fixture();
    writeFileSync(join(dir, "patches", name), "changed patch\n");
    const before = names.flatMap(files).map((path) => sha(join(dir, path)));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("patch checksum mismatch");
    expect(names.flatMap(files).map((path) => sha(join(dir, path)))).toEqual(before);
  });
  it.each(names.flatMap(files))("rejects installed file drift: %s", (path) => {
    const dir = fixture();
    writeFileSync(join(dir, path), `${readFileSync(join(dir, path), "utf8")}\n// drift\n`);
    const before = names.flatMap(files).map((target) => sha(join(dir, target)));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed bytes mismatch");
    expect(names.flatMap(files).map((target) => sha(join(dir, target)))).toEqual(before);
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
  it("preserves every shipped patch checksum", () => {
    const evidence = `2f29dcf0d8b9931bfc1a16360ac48686b642fd5ce335731d33ef7755d9e48e44  patches/@earendil-works+pi-ai+1.4.0.patch
 6f0b5e53c1bd021892743b9da101bf32847b8d6423edcf706e65b0165365f381  patches/@earendil-works+pi-coding-agent+1.4.0.patch
 1558d89f7352b7bea216a090fdbbaa50deb0e778bb65f4c0ae9aa785757d8978  patches/@earendil-works+pi-codemode+1.4.0.patch
 3e6600e43005a0d474f3941ac80a8b9541c393bab4a9e08f3274612615221bd5  patches/@earendil-works+pi-durable+1.4.0.patch`;
    for (const line of evidence.trim().split("\n")) {
      const [hash, path] = line.trim().split(/\s+/);
      expect(sha(join(root, path as string))).toBe(hash);
    }
  });
});
