import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, Result } from "neverthrow";

/** @typedef {{ type: "root_unreadable" | "patches_unreadable" | "patches_missing", message: string } | { type: "git_failed" | "patch_not_applicable", patch: string, message: string }} PatchError */
/** @typedef {{ patch: string, status: "applied" | "already_applied" }} PatchOutcome */
/** @typedef {{ type: "invalid_scope" | "seal_mismatch" | "input_unreadable", message: string } | { type: "patch_check_failed", patch: string, message: string }} SealError */

// Fixed release inputs: [pristine SHA-256, patched SHA-256] for each changed file.
const packages = [
  {
    package: "node_modules/@earendil-works/pi-ai",
    version: "1.6.1",
    patch: "@earendil-works+pi-ai+1.6.1.patch",
    sha: "4be4716fab2488d2f59c3f7b2436f09b35625c901afc911090734b2ee48e9ac8",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "2ad1b8b3f345b2c913fbc7ba16d1cc81e422f1a50e0db555793d14287895dbf4",
        "2bcc8d0b02e75cf75fbafa0c457ec4659f3dd4231f46366159540e00090fa2af",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "e1cdc7dd8c777202263aa47c0cc114aac7fe5d3f97b20202b89c1d82887ef0da",
        "9e9809dce2bce141c98f289c49cc3dfc2e5422368656554daff7f632edbf584b",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.6.1",
    patch: "@earendil-works+pi-codemode+1.6.1.patch",
    sha: "da4461068e4c2335186f947ca40ab42249478a3ea8369c3b3ce5b8393aeebf70",
    files: {
      "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js": [
        "74715f56e02642913caf8247abd9cf0c559f9ed1a5e7be210e43c104e8e70da4",
        "e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js": [
        "2e985f5967370c1ebda7af9fc261c8d62ab94129d734912cba7f47e9bf7f1fe3",
        "b2936685c9c4d6aa35fb6fc75cf8f9bb707f1ad08f711f5783dcfcfef6d90cdb",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/vm.d.ts": [
        "aeda524b2394743bc62418a4aca304f539a435d18cace78c2fa0bde7055d3777",
        "5296466cd58637cec465dbdd6d52c371b71cac68efad3d5138191492bba6cc5a",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/vm.js": [
        "279c77a80ac3d6bc1f883b02a28d892608ff43cc0b7e91dbfa3aece218c7c47b",
        "df58904095b3dec6f650b8f61c5ba174229cac78b25d63b2371bd0165c29aaa3",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js": [
        "22f72950eaaa7e7e3a816db5ce1203f2a685de0328ea097278fd74b11263d813",
        "40eedef257ef12780278476255c35bc3bd2f1f234e60cd6788f34b97b740c176",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/types.d.ts": [
        "988afeebcfd64ed6815c102dbd4e50ffe1d1c08dd32f80ba334701ff0403edc7",
        "a065c3de403312cd2abdb9d0a6ee39ed1f3f6932ffbf93df667302d3c6ef39b9",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-durable",
    version: "1.6.1",
    patch: "@earendil-works+pi-durable+1.6.1.patch",
    sha: "df8cd406718f16abb7735f01cb35dd29acbd13b7b89133f91d7ed64a8d14c3db",
    files: {
      "node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js": [
        "7dfb2ff2e047b96953c6e126a00abd04e2cc8d4f364e40cf95bfbd14cec409f1",
        "05525a03c607c054c961292159df07d7d8c26621d8d39e7889a02d3c6cbc3485",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/index.d.ts": [
        "b328bcb512baba7aff3b48df1acc9c5ed6e2868d52e72aea731d61d202169e00",
        "c678d03b880b49bbc4e27b78af952f2fd1dc000b4ff9cca61924e72fbb6a50d3",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/index.js": [
        "98c86bd9afb75bdceee8eecbff4353cf42e22f721b474cbd4a2f4124b00956f0",
        "0099469df7a479b9ee57d8f1447192dd4b3e53e51b5ce86343e62eb2af3c97fe",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/harness.js": [
        "d609227fdad775947555702fa75acccdee5300978f0ecc172b9e08eb26c548b5",
        "39b2ae1a2630e71516a757f6b1a89d2266f7599862f9dbcbb46c58f148d78105",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/submissions.js": [
        "e8f0314825d70fff8200e7626198cb73e607d1f597439cbdde0abe09cbdba2d6",
        "7f1adbd860fa669d6c0bb45cb70aa63537657903a41cd4d8f20fe2021f40f79c",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts": [
        "b5ee8c6fc888cfbb1ff3c1378a6b2fdf127394fa927563ea2523c0af057099f9",
        "236429712be13156fe4315f1e29c0a482f263e5fbcc16f2d3d488b917fdf07a1",
      ],
    },
  },
];

const canonicalRoot = Result.fromThrowable(
  /** @param {string} root */
  (root) => realpathSync(root),
  /** @returns {PatchError} */
  () => ({ type: "root_unreadable", message: "cannot resolve installation root" }),
);

const readPatches = Result.fromThrowable(
  /** @param {string} root */
  (root) =>
    readdirSync(join(root, "patches"))
      .filter((name) => name.endsWith(".patch"))
      .sort(),
  /** @returns {PatchError} */
  () => ({ type: "patches_unreadable", message: "cannot read dependency patches" }),
);

/**
 * @param {string} root
 * @param {string} patch
 * @param {string[]} flags
 * @returns {import("neverthrow").Result<{ success: boolean, message: string }, PatchError>}
 */
function gitApply(root, patch, flags) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  // Stop before the parent checkout while allowing this root's own .git.
  env.GIT_CEILING_DIRECTORIES = dirname(root);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  const launched = Result.fromThrowable(
    () =>
      spawnSync("git", ["apply", ...flags, join(root, "patches", patch)], {
        cwd: root,
        env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    /** @returns {PatchError} */
    () => ({ type: "git_failed", patch, message: "cannot launch git apply" }),
  )();
  if (launched.isErr()) return err(launched.error);
  const result = launched.value;
  if (result.error || result.signal || result.status === null)
    return err({
      type: "git_failed",
      patch,
      message: `git apply could not complete: ${result.error?.message ?? result.signal ?? "no exit status"}`,
    });
  return ok({ success: result.status === 0, message: result.stderr.trim() });
}

/**
 * @param {string} root
 * @returns {import("neverthrow").Result<PatchOutcome[], PatchError>}
 */
export function applyDependencyPatches(root) {
  const canonical = canonicalRoot(root);
  if (canonical.isErr()) return err(canonical.error);
  root = canonical.value;
  const patches = readPatches(root);
  if (patches.isErr()) return err(patches.error);
  if (patches.value.length === 0)
    return err({ type: "patches_missing", message: "no dependency patches found" });
  /** @type {PatchOutcome[]} */
  const outcomes = [];
  for (const patch of patches.value) {
    const check = gitApply(root, patch, ["--check"]);
    if (check.isErr()) return err(check.error);
    if (!check.value.success) {
      const reverse = gitApply(root, patch, ["--reverse", "--check"]);
      if (reverse.isErr()) return err(reverse.error);
      if (!reverse.value.success)
        return err({ type: "patch_not_applicable", patch, message: check.value.message });
      outcomes.push({ patch, status: "already_applied" });
      continue;
    }
    const applied = gitApply(root, patch, []);
    if (applied.isErr()) return err(applied.error);
    if (!applied.value.success)
      return err({ type: "patch_not_applicable", patch, message: applied.value.message });
    outcomes.push({ patch, status: "applied" });
  }
  return ok(outcomes);
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const inspectSealed = Result.fromThrowable(
  (root, entry) => ({
    version: JSON.parse(readFileSync(join(root, entry.package, "package.json"), "utf8")).version,
    patch: digest(join(root, "patches", entry.patch)),
    hashes: Object.entries(entry.files).map(([path, expected]) => ({
      actual: digest(join(root, path)),
      expected,
    })),
  }),
  /** @returns {SealError} */
  () => ({ type: "input_unreadable", message: "missing or unreadable dependency patch input" }),
);

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {import("neverthrow").Result<PatchOutcome[], PatchError | SealError>}
 */
function installSealed(root, args) {
  if (args.length !== 0) return err({ type: "invalid_scope", message: "expected no arguments" });
  const canonical = canonicalRoot(root);
  if (canonical.isErr()) return err(canonical.error);
  root = canonical.value;
  const pending = [];
  const outcomes = [];
  for (const entry of packages) {
    const inspected = inspectSealed(root, entry);
    if (inspected.isErr()) return err(inspected.error);
    const { version, patch, hashes } = inspected.value;
    if (version !== entry.version)
      return err({ type: "seal_mismatch", message: `wrong installed version: ${entry.package}` });
    if (patch !== entry.sha)
      return err({ type: "seal_mismatch", message: `patch checksum mismatch: ${entry.patch}` });
    const pristine = hashes.every(({ actual, expected }) => actual === expected[0]);
    const patched = hashes.every(({ actual, expected }) => actual === expected[1]);
    if (!pristine && !patched)
      return err({ type: "seal_mismatch", message: `installed bytes mismatch: ${entry.package}` });
    const check = gitApply(root, entry.patch, ["--check", ...(patched ? ["--reverse"] : [])]);
    if (check.isErr() || !check.value.success)
      return err({ type: "patch_check_failed", patch: entry.patch, message: "patch check failed" });
    if (pristine) pending.push(entry);
    outcomes.push({ patch: entry.patch, status: patched ? "already_applied" : "applied" });
  }
  for (const entry of pending) {
    const applied = gitApply(root, entry.patch, []);
    if (applied.isErr()) return err(applied.error);
    if (!applied.value.success)
      return err({
        type: "patch_not_applicable",
        patch: entry.patch,
        message: "patch application failed",
      });
    const inspected = inspectSealed(root, entry);
    if (inspected.isErr()) return err(inspected.error);
    if (!inspected.value.hashes.every(({ actual, expected }) => actual === expected[1]))
      return err({ type: "seal_mismatch", message: `patched bytes mismatch: ${entry.package}` });
  }
  return ok(outcomes);
}

if (import.meta.main) {
  const root = import.meta.dirname.endsWith("/scripts")
    ? resolve(import.meta.dirname, "..")
    : import.meta.dirname;
  const result = installSealed(root, process.argv.slice(2));
  if (result.isErr()) {
    console.error(
      `dependency patches: ${"patch" in result.error ? result.error.patch : result.error.type}: ${result.error.message}`,
    );
    process.exitCode = 1;
  } else {
    for (const { patch, status } of result.value)
      console.log(`dependency patches: ${patch}: ${status}`);
  }
}
