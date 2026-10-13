import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { guard as guardGlideos, sha as hash } from "./glideos-read-guard.mjs";
import { guard as guardIap } from "./iap-read-guard.mjs";

const lock = "42714b5e7e7bc4536d4ede553726961c11367012127dbcac18586c22b0ef5ea8";
const patch = "@earendil-works+pi-coding-agent+1.1.0.patch";
const patchHash = "f1d54d120d0de92a0ae119e6588f43fb40114f66a3508fb57547034eddf0161e";

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
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "package.json"), "utf8"));
    assert.equal(manifest.dependencies.neverthrow, "8.2.0");
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

test("Glideos rejects a substituted shipped patch even with updated file manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glideos-tamper-"));
  try {
    await mkdir(join(dir, "patches"));
    await writeFile(join(dir, "patches", patch), "altered patch");
    const root = resolve(import.meta.dirname, "../../..");
    await cp(
      join(root, "patches/@earendil-works+pi-agent-core+1.1.0.patch"),
      join(dir, "patches/@earendil-works+pi-agent-core+1.1.0.patch"),
    );
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        projectId: "35f581fb-7bbf-4542-a1e8-0d047657a71d",
        source: {
          lock,
          patches: {
            "@earendil-works+pi-agent-core+1.1.0.patch":
              "e817628f707f1d5ea2a3d0d27702919862b23303ba656dea8d30c6412da3e8e1",
            [patch]: patchHash,
            "@earendil-works+pi-ai+1.1.0.patch":
              "812225636f3c081e6e8497b0b7c98051baedea90b455f6e7f837ccc5a84be9c7",
          },
        },
        files: { [`patches/${patch}`]: hash(join(dir, "patches", patch)) },
      }),
    );
    await assert.rejects(guardGlideos(dir), /qualified patch mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const patch of [
  "@earendil-works+pi-agent-core+1.1.0.patch",
  "@earendil-works+pi-ai+1.1.0.patch",
  "@earendil-works+pi-coding-agent+1.1.0.patch",
]) {
  test(`IAP rejects substituted ${patch} with a matching mutable manifest`, async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const dir = await mkdtemp(join(tmpdir(), "iap-patch-seal-"));
    try {
      await mkdir(join(dir, "patches"));
      await cp(join(import.meta.dirname, "package-lock.json"), join(dir, "package-lock.json"));
      const files = {};
      for (const name of [
        "@earendil-works+pi-agent-core+1.1.0.patch",
        "@earendil-works+pi-ai+1.1.0.patch",
        "@earendil-works+pi-coding-agent+1.1.0.patch",
      ]) {
        const file = `patches/${name}`;
        await cp(join(root, file), join(dir, file));
        if (name === patch) await writeFile(join(dir, file), "substituted patch");
        files[file] = hash(join(dir, file));
      }
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          sourceLockSha: lock,
          lockSha: hash(join(dir, "package-lock.json")),
          files,
        }),
      );
      await assert.rejects(guardIap(dir), /qualified patch mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
