import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { guard as guardGlideos, sha as hash } from "./glideos-read-guard.mjs";
import { guard as guardIap } from "./iap-read-guard.mjs";

const lock = "88cb750557e7060e8056f00ed7bf778b8acb8e1f53c4aebd8c60da4c6865749f";
const patch = "@earendil-works+pi-coding-agent+1.0.0.patch";
const patchHash = "c684fe6a6a57426521a6fd822ced3636f2004b29eebff3af489e84f59f84c0cf";

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
  const names = [patch, "@earendil-works+pi-ai+1.0.0.patch"];
  const targets = [];
  const gitFiles = [".git/config", ".git/index"];
  const before = gitFiles.map((file) => hash(join(root, file)));
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
    assert.deepEqual(
      gitFiles.map((file) => hash(join(root, file))),
      before,
    );
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
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        projectId: "35f581fb-7bbf-4542-a1e8-0d047657a71d",
        source: {
          lock,
          vendor: "eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509",
          patches: {
            [patch]: patchHash,
            "@earendil-works+pi-ai+1.0.0.patch":
              "e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830",
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

test("IAP extracted lock resolves the included vendor archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iap-vendor-"));
  try {
    await cp(join(import.meta.dirname, "package-lock.json"), join(dir, "package-lock.json"));
    await writeFile(
      join(dir, "package-lock.json"),
      (await readFile(join(dir, "package-lock.json"), "utf8")).replaceAll(
        "file:../../../vendor/",
        "file:./vendor/",
      ),
    );
    await mkdir(join(dir, "vendor"));
    await writeFile(join(dir, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz"), "altered vendor");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        sourceLockSha: lock,
        lockSha: "ad895afd6cbf53cef4e1385065fe8620e008a3ed3a4cf5bcf15e7ae7e863dcf4",
        files: {},
      }),
    );
    await assert.rejects(guardIap(dir), /vendor archive mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
