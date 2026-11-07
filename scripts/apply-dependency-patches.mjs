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
    version: "1.5.0",
    patch: "@earendil-works+pi-ai+1.5.0.patch",
    sha: "f7d82a2a5b31d2d2ea11ce3674bb9adcd726bafd1cce43a0de62eada03ccaa37",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "13d02ecedbe4594b7c73bc3b9180e04f2a5e68e42aedfba9a366d5c082be8d57",
        "a2164c7f36198db5e1b67791f1ff3a8cb96ba376ce5617c8a3d554254f548817",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "e2944a9e1c37851e6d089556ac955ea4b253eb57a14098b53272e91fe8e84a87",
        "129dcbceef17811e2ec633d053af67c8e0eb37612353cacbfbb65c2005f0af11",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.5.0",
    patch: "@earendil-works+pi-codemode+1.5.0.patch",
    sha: "18890f0e765665ea62739c8211bd456353e84c06b57f6910a1d26ca7f17221ad",
    files: {
      "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js": [
        "74715f56e02642913caf8247abd9cf0c559f9ed1a5e7be210e43c104e8e70da4",
        "e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js": [
        "2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca",
        "5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06",
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
    version: "1.5.0",
    patch: "@earendil-works+pi-durable+1.5.0.patch",
    sha: "251c4401fea01280e9d95c71c43f1cf28fb5aaa1b05e2f66b87bfdff5699e15f",
    files: {
      "node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js": [
        "f60aaa081e12fd6dcc82dd6463d6f3750802c09a90d9388a5e31671b73822bcd",
        "8d78b130eed09bd4799f6732d7dedf77f23fde6953f3b58f857501286ef9a395",
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
        "2d55660c22a8f8bd662cb930ad65e144c0c8c7a153341abd83edd2f5c8a92137",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/submissions.js": [
        "7edf9249f84a9895e6c76d7e5956160e9af3fcaf85f73df078fdba065f796e91",
        "743358eeca029ec3a5a7b192e2d48aaa6886c2d0511cb04d5e912dd60dafd962",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts": [
        "eff2fd6232680d3367a9e7c69fe158b38e1aff2d5f182086bfe6bfc1f2b1bb66",
        "0d12a4adfa4e037d4555a9b0caeebfb3e80eda02cceada27ba5a0689ca29199e",
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
