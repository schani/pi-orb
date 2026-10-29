import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { applyDependencyPatches } from "./apply-dependency-patches.mjs";

const repository = resolve(import.meta.dirname, "..");
const directories = [];
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-dependency-patches-"));
  directories.push(root);
  mkdirSync(join(root, "patches"));
  mkdirSync(join(root, "node_modules/example"), { recursive: true });
  writeFileSync(join(root, "node_modules/example/index.js"), "before\n");
  writeFileSync(
    join(root, "patches/example+1.0.0.patch"),
    "diff --git a/node_modules/example/index.js b/node_modules/example/index.js\n" +
      "--- a/node_modules/example/index.js\n+++ b/node_modules/example/index.js\n" +
      "@@ -1 +1 @@\n-before\n+after\n",
  );
  return root;
}

test("applies patches without a Git repository and accepts already-applied patches", () => {
  const root = fixture();
  const first = applyDependencyPatches(root);
  assert.equal(first.isOk(), true);
  assert.deepEqual(first.value, [{ patch: "example+1.0.0.patch", status: "applied" }]);
  assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "after\n");
  const second = applyDependencyPatches(root);
  assert.equal(second.isOk(), true);
  assert.deepEqual(second.value, [{ patch: "example+1.0.0.patch", status: "already_applied" }]);
});

function sealedFixture(root = fixture()) {
  rmSync(join(root, "patches"), { recursive: true });
  cpSync(join(repository, "patches"), join(root, "patches"), { recursive: true });
  for (const patch of [
    "@earendil-works+pi-ai+1.4.0.patch",
    "@earendil-works+pi-codemode+1.4.0.patch",
    "@earendil-works+pi-durable+1.4.0.patch",
  ]) {
    const source = readFileSync(join(root, "patches", patch), "utf8");
    const paths = [...source.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((match) => match[1]);
    const manifest = join(paths[0].split("/").slice(0, 3).join("/"), "package.json");
    for (const path of [...paths, manifest]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repository, path), join(root, path));
    }
    const reversed = spawnSync("git", ["apply", "--reverse", join(root, "patches", patch)], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CEILING_DIRECTORIES: dirname(root),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(reversed.status, 0, reversed.stderr);
  }
  return root;
}

function sealedCli(root) {
  mkdirSync(join(root, "scripts"));
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(join(repository, "node_modules/neverthrow"), join(root, "node_modules/neverthrow"));
  return ({ cwd = root, env = {} } = {}) =>
    spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs")], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", ...env },
    });
}

for (const name of ["pi-ai", "pi-codemode", "pi-durable"]) {
  test(`refuses missing ${name} before modifying another package`, () => {
    const root = sealedFixture();
    const run = sealedCli(root);
    const target = join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
    const before = readFileSync(target);
    rmSync(join(root, `node_modules/@earendil-works/${name}/package.json`));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /input_unreadable/);
    assert.deepEqual(readFileSync(target), before);
  });
}

function nestedFixture() {
  const ancestor = fixture();
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: ancestor }).status, 0);
  const root = join(ancestor, "snapshot");
  mkdirSync(root);
  cpSync(join(ancestor, "node_modules"), join(root, "node_modules"), { recursive: true });
  cpSync(join(ancestor, "patches"), join(root, "patches"), { recursive: true });
  return { ancestor, root };
}

for (const symlinked of [false, true]) {
  test(`patches a ${symlinked ? "symlinked " : ""}snapshot beneath an ancestor checkout`, () => {
    const { ancestor, root } = nestedFixture();
    const installation = symlinked ? join(ancestor, "snapshot-link") : root;
    if (symlinked) symlinkSync(root, installation, "dir");
    const first = applyDependencyPatches(installation);
    assert.equal(first.isOk(), true, JSON.stringify(first.error));
    assert.deepEqual(first.value, [{ patch: "example+1.0.0.patch", status: "applied" }]);
    assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "after\n");
    assert.equal(readFileSync(join(ancestor, "node_modules/example/index.js"), "utf8"), "before\n");
    assert.deepEqual(applyDependencyPatches(installation).value, [
      { patch: "example+1.0.0.patch", status: "already_applied" },
    ]);
    writeFileSync(join(root, "node_modules/example/index.js"), "drift\n");
    assert.equal(applyDependencyPatches(installation).error.type, "patch_not_applicable");
    assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "drift\n");
  });
}

test("CLI seals code-mode's bounded image prelude", () => {
  const root = sealedFixture();
  const target = "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";
  const patch = "@earendil-works+pi-codemode+1.4.0.patch";
  for (const path of [
    target,
    "node_modules/@earendil-works/pi-codemode/package.json",
    "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js",
    "node_modules/@earendil-works/pi-codemode/dist/declarations.js",
    "node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js",
    "node_modules/@earendil-works/pi-codemode/dist/runtime/vm.js",
    "node_modules/@earendil-works/pi-codemode/dist/runtime/vm.d.ts",
    "node_modules/@earendil-works/pi-codemode/dist/types.d.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repository, path), join(root, path));
  }
  const hash = () =>
    createHash("sha256")
      .update(readFileSync(join(root, target)))
      .digest("hex");
  if (hash() === "5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06") {
    const reversed = spawnSync("git", ["apply", "--reverse", join(root, "patches", patch)], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(reversed.status, 0, reversed.stderr);
  }
  assert.equal(hash(), "2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca");
  const run = sealedCli(root);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /pi-codemode\+1\.4\.0\.patch: applied/);
  assert.equal(hash(), "5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06");
  assert.equal(run().status, 0);
  writeFileSync(join(root, target), `${readFileSync(join(root, target), "utf8")}\n// drift\n`);
  assert.equal(run().status, 1);
});

test("CLI ignores inherited repository selection", () => {
  const ancestor = fixture();
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: ancestor }).status, 0);
  const root = sealedFixture();
  const run = sealedCli(root);
  const result = run({
    cwd: root,
    encoding: "utf8",
    env: {
      GIT_DIR: join(ancestor, ".git"),
      GIT_WORK_TREE: ancestor,
      GIT_COMMON_DIR: join(ancestor, ".git"),
      GIT_INDEX_FILE: join(ancestor, ".git/index"),
      GIT_PREFIX: "snapshot/",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.4\.0\.patch/);
  assert.equal(readFileSync(join(ancestor, "node_modules/example/index.js"), "utf8"), "before\n");
});

test("rejects drift without changing the dependency", () => {
  const root = fixture();
  const target = join(root, "node_modules/example/index.js");
  writeFileSync(target, "unexpected\n");
  const result = applyDependencyPatches(root);
  assert.equal(result.isErr(), true);
  assert.equal(result.error.type, "patch_not_applicable");
  assert.equal(result.error.patch, "example+1.0.0.patch");
  assert.match(result.error.message, /patch does not apply/);
  assert.equal(readFileSync(target, "utf8"), "unexpected\n");
});

test("rejects missing or empty patch directories", () => {
  const root = fixture();
  rmSync(join(root, "patches/example+1.0.0.patch"));
  assert.equal(applyDependencyPatches(root).error.type, "patches_missing");
  rmSync(join(root, "patches"), { recursive: true });
  assert.equal(applyDependencyPatches(root).error.type, "patches_unreadable");
});

test("CLI resolves its installation root even when launched from a workspace", () => {
  const root = sealedFixture();
  mkdirSync(join(root, "apps/workspace"), { recursive: true });
  const run = sealedCli(root);
  const result = run({
    cwd: join(root, "apps/workspace"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.4\.0\.patch: applied/);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.4\.0\.patch/);
  const target = join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// drift\n`);
  const failure = run();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /installed bytes mismatch/);
});

test("CLI reports a missing Git executable as a typed installation failure", () => {
  const root = sealedFixture();
  const run = sealedCli(root);
  const result = run({
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: join(root, "missing-bin") },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /patch check failed/);
  assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "before\n");
});

test("CLI refuses unsealed fixtures without modifying their dependencies", () => {
  const root = fixture();
  const run = sealedCli(root);
  const result = run({
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "before\n");
});

for (const nested of [false, true]) {
  test(`preserves all shipped patches in a ${nested ? "nested" : "standalone"} install`, () => {
    const root = sealedFixture(nested ? nestedFixture().root : fixture());
    const result = applyDependencyPatches(root);
    assert.equal(result.isOk(), true, JSON.stringify(result.error));
    assert.equal(result.value.length, 3);
    assert.ok(result.value.every(({ status }) => status === "applied"));
    assert.ok(
      applyDependencyPatches(root).value.every(({ status }) => status === "already_applied"),
    );
  });
}

test("guest execution and Claude load no patched dependency files", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join, relative } from "node:path";
      import { fileURLToPath } from "node:url";
      const loaded = new Set();
      registerHooks({ load(url, context, next) {
        if (url.startsWith("file:")) loaded.add(relative(process.cwd(), fileURLToPath(url)));
        return next(url, context);
      }});
      const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
      await import("./apps/orb-runtime/src/claude/agent.ts");
      await import("./apps/orb-runtime/src/execution/server.ts");
      const cwd = await mkdtemp(join(tmpdir(), "guest-env-contract-"));
      const env = new NodeExecutionEnv({ cwd });
      const context = { value: () => undefined, toString: () => "dependency-contract" };
      const value = (result) => { assert.equal(result.ok, true, result.error?.message); return result.value; };
      try {
        value(await env.writeFile("input.txt", "one\\ntwo\\n", context));
        value(await env.appendFile("input.txt", "three\\n", context));
        assert.equal(value(await env.readTextFile("input.txt", context)), "one\\ntwo\\nthree\\n");
        value(await env.renameFile("input.txt", "output.txt", context));
        assert.equal(value(await env.fileInfo("output.txt", context)).size, 14);
        const reader = value(await env.openBinaryReader("output.txt", undefined, context));
        try { assert.equal(Buffer.from(value(await reader.read(4, 3, context))).toString(), "two"); }
        finally { await reader.close(context); }
        const missing = await env.readTextFile("missing.txt", context);
        assert.equal(missing.ok, false);
        assert.equal(missing.error.code, "not_found");
        let output = "";
        const executed = value(await env.exec("cat output.txt", { onOutput: (text) => { output += text; } }, context));
        assert.equal(executed.exitCode, 0);
        assert.equal(output, "one\\ntwo\\nthree\\n");
      } finally {
        await env.cleanup(context);
        await rm(cwd, { recursive: true, force: true });
      }
      console.log(JSON.stringify([...loaded].sort()));
      `,
    ],
    { cwd: repository, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.ok(loaded.includes("node_modules/@earendil-works/pi-durable/dist/env/node.js"));
  const patchedFiles = new Set(
    readdirSync(join(repository, "patches"))
      .filter((name) => name.endsWith(".patch"))
      .flatMap((name) =>
        [
          ...readFileSync(join(repository, "patches", name), "utf8").matchAll(
            /^diff --git a\/(\S+) b\/\S+$/gm,
          ),
        ].map((match) => match[1]),
      ),
  );
  assert.ok(patchedFiles.size > 0);
  assert.deepEqual(
    loaded.filter((path) => patchedFiles.has(path)),
    [],
  );
});

test("Pi release inputs align on stable 1.4.0 with a scoped Undici security override", () => {
  for (const path of [
    "apps/control-plane/package.json",
    "apps/orb-runtime/package.json",
    "packages/luna/package.json",
  ]) {
    const manifest = JSON.parse(readFileSync(join(repository, path), "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (name.startsWith("@earendil-works/")) assert.equal(version, "1.4.0", `${path}: ${name}`);
    }
  }
  const lock = JSON.parse(readFileSync(join(repository, "package-lock.json"), "utf8"));
  const family = Object.entries(lock.packages).filter(([path]) =>
    /(?:^|\/)node_modules\/@earendil-works\/[^/]+$/.test(path),
  );
  assert.equal(family.length, 9);
  for (const [path, entry] of family) assert.equal(entry.version, "1.4.0", path);
  for (const [owner, version] of [
    ["apps/control-plane", "7.30.1"],
    ["node_modules/@earendil-works/pi-coding-agent", "8.12.3"],
  ]) {
    const require = createRequire(join(repository, owner, "package.json"));
    assert.equal(require("undici/package.json").version, version, owner);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).overrides, {
    "@earendil-works/pi-coding-agent@1.4.0": { undici: "8.12.3" },
  });
});

for (const patch of ["pi-ai", "pi-codemode", "pi-durable"]) {
  test(`CLI seals every ${patch} file before applying any patch`, () => {
    const source = readFileSync(
      join(repository, `patches/@earendil-works+${patch}+1.4.0.patch`),
      "utf8",
    );
    const paths = [...source.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((match) => match[1]);
    for (const path of paths) {
      const root = sealedFixture();
      const run = sealedCli(root);
      const target = join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
      writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}\n// drift\n`);
      const before = readFileSync(target);
      const result = run();
      assert.equal(result.status, 1, path);
      assert.match(result.stderr, /installed bytes mismatch/);
      assert.deepEqual(readFileSync(target), before, path);
    }
  });
  test(`CLI rejects a wrong ${patch} version before applying any patch`, () => {
    const root = sealedFixture();
    const run = sealedCli(root);
    const target = join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
    const before = readFileSync(target);
    writeFileSync(
      join(root, `node_modules/@earendil-works/${patch}/package.json`),
      '{"version":"1.3.0"}',
    );
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /wrong installed version/);
    assert.deepEqual(readFileSync(target), before);
  });
}
