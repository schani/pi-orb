import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const patch = "@earendil-works+pi-coding-agent+1.1.0.patch";

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("shipped Pi-only helper applies and reapplies in checkout staging and extracted archive", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const pristine = await mkdtemp(join(tmpdir(), "standalone-pristine-"));
  const context = join(root, ".context");
  await mkdir(context, { recursive: true });
  const owned = await mkdtemp(join(context, "standalone-git-contract-"));
  const stage = join(owned, "staging");
  const extracted = join(pristine, "extracted");
  const names = [
    patch,
    "@earendil-works+pi-ai+1.1.0.patch",
    "@earendil-works+pi-agent-core+1.1.0.patch",
    "@earendil-works+pi-codemode+1.1.0.patch",
  ];
  const targets = [];
  const gitFiles = ["config", "index"].map((file) => {
    const result = spawnSync("git", ["rev-parse", "--git-path", file], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return resolve(root, result.stdout.trim());
  });
  const before = gitFiles.map(hash);
  try {
    await cp(join(root, "node_modules/neverthrow"), join(pristine, "node_modules/neverthrow"), {
      recursive: true,
    });
    await mkdir(join(pristine, "patches"));
    await cp(
      join(root, "scripts/apply-dependency-patches.mjs"),
      join(pristine, "apply-dependency-patches.mjs"),
    );
    for (const name of names) {
      await cp(join(root, "patches", name), join(pristine, "patches", name));
      const changed = [
        ...(await readFile(join(root, "patches", name), "utf8")).matchAll(
          /^diff --git a\/(\S+) b\/\S+$/gm,
        ),
      ].map((match) => match[1]);
      targets.push(...changed);
      const manifest = `${changed[0].split("/").slice(0, 3).join("/")}/package.json`;
      for (const file of [...changed, manifest]) {
        await mkdir(dirname(join(pristine, file)), { recursive: true });
        await cp(join(root, file), join(pristine, file));
      }
      run(pristine, "git", ["apply", "--reverse", "--", join(pristine, "patches", name)]);
    }
    await cp(pristine, stage, { recursive: true });
    run(owned, "tar", ["-czf", "standalone.tgz", "staging"]);
    await mkdir(extracted);
    run(owned, "tar", ["-xzf", "standalone.tgz", "-C", extracted]);
    for (const dir of [stage, join(extracted, "staging")]) {
      assert.equal(
        hash(join(dir, "apply-dependency-patches.mjs")),
        hash(join(root, "scripts/apply-dependency-patches.mjs")),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        run(dir, process.execPath, ["apply-dependency-patches.mjs", "--pi-only"]);
        for (const file of targets) assert.equal(hash(join(dir, file)), hash(join(root, file)));
      }
      for (const name of names)
        assert.equal(hash(join(dir, "patches", name)), hash(join(root, "patches", name)));
      assert.equal(existsSync(join(dir, ".git")), false);
    }
    assert.deepEqual(gitFiles.map(hash), before);
  } finally {
    await rm(pristine, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});
