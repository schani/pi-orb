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
    package: "node_modules/@earendil-works/pi-agent-core",
    version: "1.0.0",
    patch: "@earendil-works+pi-agent-core+1.0.0.patch",
    sha: "7e2c5e2d68d97419c086ac5d369f6d2b83be2020a3be062e1a1402b37ab0cdb2",
    files: {
      "node_modules/@earendil-works/pi-agent-core/dist/agent.js": [
        "163ad28551f1c38b8eb899a5c9dd89cd9d9005fb7dd9c4abeb008ee380e98c51",
        "d812a39c0e3f446e787a1d395349e95dec32d4622daa9c4223e509b9116b2948",
      ],
      "node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts": [
        "1ae9fb28e132a7d0c545c96b69bca5a69db1374695853d12921bc623709a7589",
        "04ece9f4511c543a845773e05d2a4126cd0fe7871074120cc4a8c25731f3f959",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-ai",
    version: "1.0.0",
    patch: "@earendil-works+pi-ai+1.0.0.patch",
    sha: "e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "53b4abdad5f2af1e5e5c12605d96bf6651d4a4b847351d87898ebb67d04236f7",
        "60bf3cca09a7f242c79dee2e6fa6be5fd13b553733fd1432147e99d73ee0b041",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "7e6a457a6f60029187b722456fa883d4eb6e5219f871c65bba323c1f8bb4eca2",
        "215e5b93dc064e05d76cc2f6ec7a227f383dacd1b75cc5bb7a882564b83c768e",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-coding-agent",
    version: "1.0.0",
    patch: "@earendil-works+pi-coding-agent+1.0.0.patch",
    sha: "a7eda2ad337b150f45f2516ee2b77a159cd081f68a16479b61ba48ee68b9fc73",
    files: {
      "node_modules/@earendil-works/pi-coding-agent/dist/index.js": [
        "5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30",
        "8eeb60482fa53247e279672d6b4575c80d464b8713d44cbfbbba718bac04757a",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts": [
        "9a3f40fa77a28e00f3d5a41a95a137e90a920e1bef10e482eebe621fe2d3d818",
        "b022d36e5a0926a4078fef3a28cbce08f6ead70d5453742472d8746eb902d9ac",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js": [
        "da26f76339a031456f6d239a249159231776f760ab4ac538c6b54c417dea6f67",
        "b521abfccb39a84d73f60e78336c7e80104ee65be2732ec3764e4c89eac1798f",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts": [
        "2e50b35a37f9c7149c6297ae554b2d965bd74dbfcb8ccd7be44f13226ce497e7",
        "07be0b969ec9283870a1ee3bc365f41df54477104ff3c4cee399e3b5fc7368f2",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js": [
        "476722dd363a0347049d450b5a0c67386cf156ecae2b039676962aa00a857161",
        "2807891eb2151a95a6c1f418b0122b4f2461c8aacc83f8a6a8b0f40d659d9b58",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.d.ts": [
        "6e16948b43e3946cd8156ccc4fb59b10a979094b4576cb5352af4f51760e389d",
        "a876473816d9895ba9e62f47d2bffa007a23c38c6eafd64ce2e8464bc4e583d0",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js": [
        "7583772d6d29a23c06496b6e0b4764ace220fb4289d5523916323642efa50306",
        "55b672d32fd0c0cdfad7a1f25a5e532062ee585c5b79dbc56f972804d1333fac",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.d.ts": [
        "72965af90f1062eca0f2c3fd643a57b5999001ddf942abab009db8c83691a7fd",
        "6e8b59f164840532bf9bf5dce695a5a5bd780711c0662bfe0537b6b686ada7bb",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js": [
        "46788ee4d3d6c5e93686920701e070692691cd6505e3bf9768eafac82c45157d",
        "aaad9edb09ecd6646fb643daabab69a2c51ac037561c4a738800fa1ee7165860",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js": [
        "1c4ee9b558a158ad88ebab5e1f6b267e53a09f4a49547481a6371d38502f47ad",
        "6a2fbaa23297782545515f19b782a78374d61d8bebc4969f5902b7774245abfa",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.d.ts": [
        "b057b9bda3956f978ce3836c76f453aa13185a9dd8585876b3491daa9beec795",
        "b0dbfa15209002de509423d2bab354c635b4ec2fbc0233440a3b49871610dabe",
      ],
    },
  },
  {
    package: "node_modules/@gotgenes/pi-subagents",
    version: "21.7.0-orb.8",
    patch: "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
    sha: "adcb859f8c0a0348ae7c745f16f35d2715e948f36542196b3b9c1c7c7c7bf571",
    files: {
      "node_modules/@gotgenes/pi-subagents/dist/extension.js": [
        "ebf9e0c343ec6458eecc3c2aa002f302373a8056a92ee46ad7ac1b117ad9087e",
        "faabc7c3f2dd14716b7bcf188d4f146b15259f6b4fe7dbd16d62c6fdd9c23dad",
      ],
      "node_modules/@gotgenes/pi-subagents/src/config/agent-types.ts": [
        "d4496903cfd7cf8d77a672dd3a01267b79cf85d66cf334b1ba0e155eb5cc50f9",
        "5e5e6527f686b07196b6142cd3a3f06ca85d5ea919e3c9027ddf75624e1fa96f",
      ],
      "node_modules/@gotgenes/pi-subagents/src/index.ts": [
        "292afe9a3e81c8927fd4319df6c8a2250e06bdbaee49f598e73cf8ab8aa17fb3",
        "177df1859911fdb68c54de3e2b60c0d41b98866c12688777717792abe9a7f4b3",
      ],
      "node_modules/@gotgenes/pi-subagents/src/lifecycle/create-subagent-session.ts": [
        "55e6c308310826f272e0e977beba41ec772d5e8abf5b8bacc0fbb5751083e237",
        "9e965ddecafd730efb9aa4b1a023f9e899dc78d4d7b0a3f0c5d724095ccf4bd2",
      ],
      "node_modules/@gotgenes/pi-subagents/src/session/session-config.ts": [
        "25d0e591f268cd55f27c21c9a035d7a3e16f1a2733c5bea8c7aaf650907b85d8",
        "239ff373b92dc69fec259dde5baa3e6d29cbe0452811af05acd291c3c38155aa",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-codemode",
    version: "1.0.0",
    patch: "@earendil-works+pi-codemode+1.0.0.patch",
    sha: "22e2c44d23d239be85ddfc012cc9878c770b1d8453e90cdc60532b2b4ebc8555",
    files: {
      "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js": [
        "68e5505a9ab9e19ffa0fd7bb8f93147927fd27a72cf294bb122a7faca992348d",
        "d19de32cbdde1cc7f1aabdf3aa83c36e63776594da1aeae94dd006bbe80d338c",
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
  if (args.length > 1 || (args.length === 1 && args[0] !== "--pi-only"))
    return err({ type: "invalid_scope", message: "expected no arguments or --pi-only" });
  const canonical = canonicalRoot(root);
  if (canonical.isErr()) return err(canonical.error);
  root = canonical.value;
  const piPackages = new Set([
    "node_modules/@earendil-works/pi-agent-core",
    "node_modules/@earendil-works/pi-ai",
    "node_modules/@earendil-works/pi-coding-agent",
    "node_modules/@earendil-works/pi-codemode",
  ]);
  const selected =
    args.length === 1 ? packages.filter((entry) => piPackages.has(entry.package)) : packages;
  const pending = [];
  const outcomes = [];
  for (const entry of selected) {
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
