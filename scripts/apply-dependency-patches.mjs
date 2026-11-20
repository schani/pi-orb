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
    version: "1.5.2",
    patch: "@earendil-works+pi-ai+1.5.2.patch",
    sha: "5cbc618e470d84997f02f29f0afa1fcfa98f5638320ce8312b618cf5b64f1543",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json": [
        "dd30453068f310317abf35d9adc6d841339a1351f0c6925a6aff45d975e0257c",
        "f0c261c8cf125f584fb4952c0a2489b9c1b0ea78cb1c601c4cd0d9ca9c72c03f",
      ],
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "4a756bd6c87a6357a811ee512f47d5c3991026bcd213e00a4330be7b0fb4a80d",
        "550d3b2d65ecb9be8791d662ddd972f3ba30b124614cafa104f1fedce46b26a7",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "c0ecd26c0170c7d6016c734ec38b551c7d8c7d8e6573f82f7f6a3818df84acd8",
        "0bb8424711d971e0a498a410712dc959c64309471caa304517a8a905542404d3",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.5.2",
    patch: "@earendil-works+pi-codemode+1.5.2.patch",
    sha: "766ee71d04ada7a1b7780e4777843cbd4aec2c3ec07f44089b1ba7b49930a0de",
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
    version: "1.5.2",
    patch: "@earendil-works+pi-durable+1.5.2.patch",
    sha: "d37cc749f132a1f7dc67838a5e8287f8376a6b53eaf6e19876fa23e3dd7aa137",
    files: {
      "node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js": [
        "5ff50eefde02cc17f4eeefc3fccba25551d4fd9245b7876ab03f8ca7015faffc",
        "cb2ef09fdd8899370c0081e6bf4b19b01170eb1e3e8a88b4bc257d4bae7d3489",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/index.d.ts": [
        "957445b146e49e4b76107b97e280f763101c5c8a17989db12fdcec58e3c16e71",
        "151862144105f9ee00b154c09b8af871a7e64d3b9b130e07f7d2d5cd09195a05",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/index.js": [
        "a8989014539cd530e35d53e50f1fd0cb823a2a711f30ae20719ca92cfb99695e",
        "51a53f80d552962f2e1bc9b85e876ac019615e5d593c533d2506f0a215aa54dd",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/output.js": [
        "74f9e9f346c1cc807642aae02342958de661faf1e9d7e09cff3f5a3471292470",
        "c9c97f22a63482eeaa1072dbd3800f50537072b15173b845026433ba9f57b6da",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/harness.js": [
        "4096cbb0756c59606a0b6437909a879b5c603fde2d2a9bc25854398e30b25e47",
        "af2d052776f81482ca69640dcd8968b1fc46227bc65deb2b764518c42546d82d",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/submissions.js": [
        "ba88af50a76b5c3dcef990b6b3c37316da856f83cce24b1453ae5035c052d939",
        "20b03f162939401e7eabb6afb0f916804eddd94ac2b1bbd56bf24778a74234f0",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts": [
        "413d8bf8623b52ad18ee5844e20edc977a47500961431a9b64e83bda70e92fbd",
        "8e348a7c9e43e6e68e83a49042e55d88002d6b9b8e0e08405ae43d482530b002",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/util.js": [
        "5519388f097d51fbf8f5811edd11d04076523253a2a11ae8689082ae8e2df4d9",
        "6e842a44631ad46b2be026f8a5a06e6805155fdc92a518a910bf8269cd109d95",
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
