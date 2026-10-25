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
    version: "1.4.0",
    patch: "@earendil-works+pi-ai+1.4.0.patch",
    sha: "a6b44d4207768ed1479a7eef0b25402e241763f5a8265098937d42adb702002e",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "339c75c5799ec3baca669114e3779988f819a5479e2b2c43dfa0b0f05b921c92",
        "51051cce5f9ea3b8f896687c0a1a993f253fd890bc7457b441ebddd54fbb3233",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "9348589a0c88c61e78e8575539cec4bf4e4fba8bf9029d3535ddeae07cb1c696",
        "0f5d7002f927971e100157d63343c3e32ef25a2b2ec385e6c1433883f75593bf",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.4.0",
    patch: "@earendil-works+pi-codemode+1.4.0.patch",
    sha: "1558d89f7352b7bea216a090fdbbaa50deb0e778bb65f4c0ae9aa785757d8978",
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
    version: "1.4.0",
    patch: "@earendil-works+pi-durable+1.4.0.patch",
    sha: "3326dd20ce27c8b1679fa98a136fa6f18df6441f289011aae7b35c664cbf070f",
    files: {
      "node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js": [
        "0963efb938700fe914e4a7a99c232fd6f5596bd490900574d187706f08da702a",
        "577b240911724557fc43d765e75ede0ecaf3407ab76a6d4388f7359571154ea5",
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
        "472fe31f5525045ec4b27437a2049236f4f58cce4920aa9bd49e41445097574d",
        "4c450554cdd1f7611bca22a457e0fb5a9764649ccf85f57c23c7627538d2ad0b",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/submissions.js": [
        "d171c6a0b3438471911277091117ad48d73f2af853d5b6b7a0f547c28782c9ac",
        "7583cb43b8b2473d89edfd6e2e4e9279e6177d7c6dc0b31bf7ed59fc1acd86c8",
      ],
      "node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts": [
        "d370cfc70bbaf6a966f65a2c30cdd7425ccee81f6e15fb9409fac0d6ff881862",
        "b4b632ae0201bec6cfddef70f48a7187fc77e060d209904d9b06424494f8c74b",
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
