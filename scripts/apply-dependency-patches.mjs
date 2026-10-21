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
    version: "1.3.0",
    patch: "@earendil-works+pi-ai+1.3.0.patch",
    sha: "e709d41ab45ae8e5847ffe96171751d8e7618afc0f54f47a6ca2ddb4c52d5abf",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "4d90da82aaac68f9f0e1fd7daec39f1aa285c111bf04c7ddefa52e920b41b2cc",
        "5258feb1ff978ebee5428fe0b2a2dea5ed1f12c9b867cc3122e9f4af16ad0f59",
      ],
      "node_modules/@earendil-works/pi-ai/dist/auth/resolve.js": [
        "3fcec09018831324d9c7fb02f4aea707e8a9e4fec5a2bdf1b3d84d716fd3091e",
        "e1b7e3e1559bda8d31e29a7f87e3525f0da07fb07b70dea560cc5920733adbed",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "4e76c0f67e2cb7243321059dbe212b676835c98ccc78344b3e2b052521e6803e",
        "731961ab0075f59551902e60dd6654e27b42e65be3a14e08f28286fc7f650c2a",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-coding-agent",
    version: "1.3.0",
    patch: "@earendil-works+pi-coding-agent+1.3.0.patch",
    sha: "5ccd27bea08593d9ac2307ed5d3d6ee977d88b6cc531bedf59db55aa46329348",
    files: {
      "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js": [
        "578b742bea061fed029b8e139c6c0bcfe31e60665e9c0c6a08769761ef169dfd",
        "619ebeafc6bc2ddc7b681dac17b0b54d214fc5d1ad953bf4c4559346e162a598",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.d.ts": [
        "b8fe1ab3313ec7f87d8e451f97f742f52f6f8cc1f4c05d2d9e4bad49063ffb08",
        "58823e0268b493bae5a504aafaecde3cc9a4f02d1d95e6537d7a747578e9bca2",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.3.0",
    patch: "@earendil-works+pi-codemode+1.3.0.patch",
    sha: "ce5992310bf98e79f2c3242a76a80a008383a822a5a0447b354cda097480cfa1",
    files: {
      "node_modules/@earendil-works/pi-codemode/dist/declarations.js": [
        "00ab54f850a7412d029f8d9699fcb51b1346f3cb2c58e47b63f9189292ec260c",
        "93ea4e2a077874b6b273b5091965d208e5e2aa7668cb6215e538cc811c6d266a",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js": [
        "74715f56e02642913caf8247abd9cf0c559f9ed1a5e7be210e43c104e8e70da4",
        "e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js": [
        "2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca",
        "5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js": [
        "22f72950eaaa7e7e3a816db5ce1203f2a685de0328ea097278fd74b11263d813",
        "33c9418251b64423ee5e8fdb0fefecdb7346b203780150f8ed33a146ff2bf533",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/types.d.ts": [
        "988afeebcfd64ed6815c102dbd4e50ffe1d1c08dd32f80ba334701ff0403edc7",
        "a065c3de403312cd2abdb9d0a6ee39ed1f3f6932ffbf93df667302d3c6ef39b9",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-durable",
    version: "1.3.0",
    patch: "@earendil-works+pi-durable+1.3.0.patch",
    sha: "1c275400b15174c92868d55944417eb129f15b6eca7c80e5dc0495587e8c81a9",
    files: {
      "node_modules/@earendil-works/pi-durable/dist/harness/harness.js": [
        "6ba34d69844588e6c57d7b8fb02175497b1a75dcc1c51325bb0ef78109939faf",
        "b93bcd82260a7dfd66ca1628e676587a664a1d54382995d7a69f92dea17385a2",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts": [
        "baf6e81f1c8e2b0b13d74cb4af02eb93d3d2bcd041920c99c8895f88bb486123",
        "9d6df604f4ef16f67f3b9499c8e94efd68937bff3260d3dab5f27e186865888e",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/submissions.js": [
        "58473285751a2a569ebe43511cb5d605432fa57913dc45684f7d00d3c1012ca1",
        "1f634f2119a01616b2f51f7d8ec5f2be338c7409c0ab4935df20c3e90c0a3f30",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/generation.js": [
        "c7902ec218c6268474969142a70d4ba485eb75c7ee18f6d75c3923a60510c34e",
        "6c1d935ab46c5c7f95bd756215752c3d7b6262ec466d19ecbc97f6698366357b",
      ],
      "node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js": [
        "d1285a561065660e701c78c3879a7e970d595a991fe4a9696827282444b29599",
        "ee0e6368e2e4caf40ef84934418e2e4155c8f012acf8c5b0eff9100c4c36de9f",
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
