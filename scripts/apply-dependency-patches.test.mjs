import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function sealedFixture(completeSdk = false) {
  const root = fixture();
  rmSync(join(root, "patches"), { recursive: true });
  cpSync(join(repository, "patches"), join(root, "patches"), { recursive: true });
  if (completeSdk) {
    for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-codemode"])
      cpSync(
        join(repository, "node_modules/@earendil-works", name),
        join(root, "node_modules/@earendil-works", name),
        { recursive: true },
      );
  }
  for (const patch of [
    "@earendil-works+pi-agent-core+1.0.0.patch",
    "@earendil-works+pi-ai+1.0.0.patch",
    "@earendil-works+pi-coding-agent+1.0.0.patch",
    "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
    "@earendil-works+pi-codemode+1.0.0.patch",
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
      env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.equal(reversed.status, 0, reversed.stderr);
  }
  return root;
}

function piOnlyCli(root) {
  mkdirSync(join(root, "scripts"));
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(join(repository, "node_modules/neverthrow"), join(root, "node_modules/neverthrow"));
  return () =>
    spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs"), "--pi-only"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
}

test("Pi-only installs core, AI, coding-agent and codemode and exposes selective cancellation", () => {
  const root = sealedFixture(true);
  rmSync(join(root, "node_modules/@gotgenes"), { recursive: true });
  rmSync(join(root, "patches/@gotgenes+pi-subagents+21.7.0-orb.8.patch"));
  const run = piOnlyCli(root);
  for (const entry of readdirSync(join(repository, "node_modules"))) {
    if (entry === "@earendil-works") {
      for (const name of readdirSync(join(repository, "node_modules", entry))) {
        const target = join(root, "node_modules", entry, name);
        if (!existsSync(target)) symlinkSync(join(repository, "node_modules", entry, name), target);
      }
    } else if (entry !== "@gotgenes" && !existsSync(join(root, "node_modules", entry))) {
      symlinkSync(join(repository, "node_modules", entry), join(root, "node_modules", entry));
    }
  }
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const api = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { AgentSession } from "@earendil-works/pi-coding-agent"; if (typeof AgentSession.prototype.cancelQueuedCustomSteer !== "function") process.exit(1);',
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(api.status, 0, api.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "dependency patches: @earendil-works+pi-agent-core+1.0.0.patch: applied",
    "dependency patches: @earendil-works+pi-ai+1.0.0.patch: applied",
    "dependency patches: @earendil-works+pi-coding-agent+1.0.0.patch: applied",
    "dependency patches: @earendil-works+pi-codemode+1.0.0.patch: applied",
  ]);
  assert.match(
    readFileSync(
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts"),
      "utf8",
    ),
    /cancelQueuedCustomSteer/,
  );
  assert.equal(run().status, 0);
});

for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-codemode"]) {
  test(`Pi-only refuses missing ${name} before modifying another package`, () => {
    const root = sealedFixture();
    const run = piOnlyCli(root);
    const target = join(root, "node_modules/@earendil-works/pi-agent-core/dist/agent.js");
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

for (const scope of [[], ["--pi-only"]]) {
  test(`CLI seals code-mode's bounded image prelude (${scope.join(" ") || "all"})`, () => {
    const root = sealedFixture();
    const target = "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";
    const patch = "@earendil-works+pi-codemode+1.0.0.patch";
    for (const path of [
      target,
      "node_modules/@earendil-works/pi-codemode/package.json",
      "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js",
      "node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js",
      "node_modules/@earendil-works/pi-codemode/dist/types.d.ts",
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repository, path), join(root, path));
    }
    const hash = () =>
      createHash("sha256")
        .update(readFileSync(join(root, target)))
        .digest("hex");
    if (hash() === "d19de32cbdde1cc7f1aabdf3aa83c36e63776594da1aeae94dd006bbe80d338c") {
      const reversed = spawnSync("git", ["apply", "--reverse", join(root, "patches", patch)], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(reversed.status, 0, reversed.stderr);
    }
    assert.equal(hash(), "68e5505a9ab9e19ffa0fd7bb8f93147927fd27a72cf294bb122a7faca992348d");
    mkdirSync(join(root, "scripts"));
    cpSync(
      join(repository, "scripts/apply-dependency-patches.mjs"),
      join(root, "scripts/apply-dependency-patches.mjs"),
    );
    symlinkSync(
      join(repository, "node_modules/neverthrow"),
      join(root, "node_modules/neverthrow"),
      "dir",
    );
    const run = () =>
      spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs"), ...scope], {
        cwd: root,
        encoding: "utf8",
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /pi-codemode\+1\.0\.0\.patch: applied/);
    assert.equal(hash(), "d19de32cbdde1cc7f1aabdf3aa83c36e63776594da1aeae94dd006bbe80d338c");
    assert.equal(run().status, 0);
    writeFileSync(join(root, target), `${readFileSync(join(root, target), "utf8")}\n// drift\n`);
    assert.equal(run().status, 1);
  });
}

test("CLI ignores inherited repository selection", () => {
  const ancestor = fixture();
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: ancestor }).status, 0);
  const root = sealedFixture();
  mkdirSync(join(root, "scripts"));
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(
    join(repository, "node_modules/neverthrow"),
    join(root, "node_modules/neverthrow"),
    "dir",
  );
  const result = spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: join(ancestor, ".git"),
      GIT_WORK_TREE: ancestor,
      GIT_COMMON_DIR: join(ancestor, ".git"),
      GIT_INDEX_FILE: join(ancestor, ".git/index"),
      GIT_PREFIX: "snapshot/",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.0\.0\.patch/);
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
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/workspace"), { recursive: true });
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(
    join(repository, "node_modules/neverthrow"),
    join(root, "node_modules/neverthrow"),
    "dir",
  );
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  const result = spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs")], {
    cwd: join(root, "apps/workspace"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.0\.0\.patch: applied/);
  assert.match(result.stdout, /@earendil-works\+pi-ai\+1\.0\.0\.patch/);
  const target = join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// drift\n`);
  const failure = spawnSync(
    process.execPath,
    [join(root, "scripts/apply-dependency-patches.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /installed bytes mismatch/);
});

test("CLI reports a missing Git executable as a typed installation failure", () => {
  const root = sealedFixture();
  mkdirSync(join(root, "scripts"));
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(
    join(repository, "node_modules/neverthrow"),
    join(root, "node_modules/neverthrow"),
    "dir",
  );
  const result = spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs")], {
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
  mkdirSync(join(root, "scripts"));
  cpSync(
    join(repository, "scripts/apply-dependency-patches.mjs"),
    join(root, "scripts/apply-dependency-patches.mjs"),
  );
  symlinkSync(
    join(repository, "node_modules/neverthrow"),
    join(root, "node_modules/neverthrow"),
    "dir",
  );
  const result = spawnSync(process.execPath, [join(root, "scripts/apply-dependency-patches.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, "node_modules/example/index.js"), "utf8"), "before\n");
});

for (const nested of [false, true]) {
  test(`preserves all shipped patches in a ${nested ? "nested" : "standalone"} install`, () => {
    const root = nested ? nestedFixture().root : fixture();
    rmSync(join(root, "patches"), { recursive: true });
    cpSync(join(repository, "patches"), join(root, "patches"), { recursive: true });
    for (const patch of [
      "@earendil-works+pi-agent-core+1.0.0.patch",
      "@earendil-works+pi-ai+1.0.0.patch",
      "@earendil-works+pi-codemode+1.0.0.patch",
      "@earendil-works+pi-coding-agent+1.0.0.patch",
      "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
    ]) {
      const source = readFileSync(join(root, "patches", patch), "utf8");
      for (const line of source.split("\n")) {
        if (!line.startsWith("diff --git ")) continue;
        const path = line.split(" ")[2].slice(2);
        mkdirSync(join(root, path, ".."), { recursive: true });
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
    const result = applyDependencyPatches(root);
    assert.equal(result.isOk(), true, JSON.stringify(result.error));
    assert.equal(result.value.length, 5);
    assert.ok(result.value.every(({ status }) => status === "applied"));
    assert.ok(
      applyDependencyPatches(root).value.every(({ status }) => status === "already_applied"),
    );
  });
}
