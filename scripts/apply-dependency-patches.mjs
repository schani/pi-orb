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
    version: "1.1.0",
    patch: "@earendil-works+pi-agent-core+1.1.0.patch",
    sha: "e817628f707f1d5ea2a3d0d27702919862b23303ba656dea8d30c6412da3e8e1",
    files: {
      "node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts": [
        "1ae9fb28e132a7d0c545c96b69bca5a69db1374695853d12921bc623709a7589",
        "04ece9f4511c543a845773e05d2a4126cd0fe7871074120cc4a8c25731f3f959",
      ],
      "node_modules/@earendil-works/pi-agent-core/dist/agent.js": [
        "163ad28551f1c38b8eb899a5c9dd89cd9d9005fb7dd9c4abeb008ee380e98c51",
        "d812a39c0e3f446e787a1d395349e95dec32d4622daa9c4223e509b9116b2948",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-ai",
    version: "1.1.0",
    patch: "@earendil-works+pi-ai+1.1.0.patch",
    sha: "00c77c3ef2de00b331886971cac1c84f7efd8c68a494b48c7db9128418027a58",
    files: {
      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": [
        "b185956e11a5c5cb522e5cad77daf21ce31c3c304e86a8333ffcb49ff78466ea",
        "48d7d64da1c9d7e5c16d06bb7735cb95ed5e24c775a62bc3dd081683c832573a",
      ],
      "node_modules/@earendil-works/pi-ai/dist/auth/resolve.js": [
        "3fcec09018831324d9c7fb02f4aea707e8a9e4fec5a2bdf1b3d84d716fd3091e",
        "e1b7e3e1559bda8d31e29a7f87e3525f0da07fb07b70dea560cc5920733adbed",
      ],
      "node_modules/@earendil-works/pi-ai/dist/types.d.ts": [
        "3f955155de2ab15e03e509d30d6f800ba8b7c81216b2c86edfbf68e6e59260bc",
        "21a8f0fb9bd340ad5ab26d1f8645dfc9623da4cd299fa45f72c8cc1d3fb13333",
      ],
    },
  },
  {
    package: "node_modules/@earendil-works/pi-coding-agent",
    version: "1.1.0",
    patch: "@earendil-works+pi-coding-agent+1.1.0.patch",
    sha: "f1d54d120d0de92a0ae119e6588f43fb40114f66a3508fb57547034eddf0161e",
    files: {
      "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts": [
        "a3d494295855517aab33ca3ec3890b3e181f25b695fb656a5dd9c262f8677906",
        "f887b424eb0a1bd7c4c91698d8a76cb335600f5a3bcbf4cd6a1fe07457116854",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js": [
        "0ba5c847b4fd2fd838f71ea84885b9f3a4f15d9bf4b5493e2e88a41d1507e20b",
        "ade229667194bfcce92c5b7e4d4b74745c440fa55911960ef822e22b12c98cdc",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js": [
        "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36",
        "de670334e496ca4df07c56d78183aa13b8708436cfa964aa36fc9ba2e8fa7797",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js": [
        "732c2be87ac94ceb1f9c68074eb78c15bc189f21671414bb91bcd0cf141d5b9c",
        "783bb0e1f36f3fb9fbd08ae310767a2d07b7a1149f87671a4099f91cf53328aa",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.d.ts": [
        "b8fe1ab3313ec7f87d8e451f97f742f52f6f8cc1f4c05d2d9e4bad49063ffb08",
        "58823e0268b493bae5a504aafaecde3cc9a4f02d1d95e6537d7a747578e9bca2",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.d.ts": [
        "2326ac2f37daa7bbf258629846b4ff6d4d8d2c570331777b2da0852525de843e",
        "ab7976c5aa2fd778d2de86681e683bd0f5496bb5d25f9a06b96371856d7d7e76",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js": [
        "ee7e759f8b1e3946226a87f3af5e9af74a5a65106888037b890d4680faaea2d5",
        "a14e437300b8641bebeb1bffb82a2b82b5a351b38863cc7dc144d6d8cdea3247",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.d.ts": [
        "15d7bc9ee02e59c1b9e04c254fd43fe45ce4abfc0fc034dfdb12442d0e5b1a9b",
        "217e0c0c6598217db62dc1c9d5288b98b935aab013e320c9114db364d3614b0b",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js": [
        "55f0d73d76a80b5343781ea5d99b7ab248e201276c4552dc55cce7bee972852c",
        "96f206062e86918704f27af1a4c5048b9b5cd382d6f393a75e3b1c34a2f0e469",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts": [
        "b254e36846b1dcc64ce1a8ba72e23fb410df4aa4408ba8c23e69e5b3f934e3cc",
        "074c9da9c42c8bcdbffdb0e233ead596df0fafdc2bc7b1994af252993c3ae75d",
      ],
      "node_modules/@earendil-works/pi-coding-agent/dist/index.js": [
        "5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30",
        "8eeb60482fa53247e279672d6b4575c80d464b8713d44cbfbbba718bac04757a",
      ],
    },
  },
  {
    package: "node_modules/@gotgenes/pi-subagents",
    version: "21.7.0-orb.8",
    patch: "@gotgenes+pi-subagents+21.7.0-orb.8.patch",
    sha: "b3e48bde4e53ead071abf15eae78b26dc5ea01441d8946782ba2284f1da06f9a",
    files: {
      "node_modules/@gotgenes/pi-subagents/dist/extension.js": [
        "ebf9e0c343ec6458eecc3c2aa002f302373a8056a92ee46ad7ac1b117ad9087e",
        "9589e69fdbd0dac396f0192f0f76065f1bca9da54aa576ab52a7933c3abaf976",
      ],
      "node_modules/@gotgenes/pi-subagents/src/config/agent-types.ts": [
        "d4496903cfd7cf8d77a672dd3a01267b79cf85d66cf334b1ba0e155eb5cc50f9",
        "5e5e6527f686b07196b6142cd3a3f06ca85d5ea919e3c9027ddf75624e1fa96f",
      ],
      "node_modules/@gotgenes/pi-subagents/src/index.ts": [
        "292afe9a3e81c8927fd4319df6c8a2250e06bdbaee49f598e73cf8ab8aa17fb3",
        "5a1ab00e5701ef884cad07ebe5d9a4741c559edee6f176942fd33a9f02eaf484",
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
    version: "1.1.0",
    patch: "@earendil-works+pi-codemode+1.1.0.patch",
    sha: "698bac6a2644dd02f58961cfac801c30453eb6264306996ed25fec4388a44a84",
    files: {
      "node_modules/@earendil-works/pi-codemode/dist/runtime/host.js": [
        "dc4f04cc4a9817d101ab07f86141d1a3c7cdc549721ccd1ec9f519a30dc369cf",
        "c7299e72f9515cacc2cf30e7bc79bc5ec47bfa1a2dddb8ec78815535179b6739",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js": [
        "19379bd753e82b795a89168aedbb1e0b86d314e33dce4d11810c036520b0dfcf",
        "6d431bb8c1aba7eb1ce6ecd6539bf3c19a84824ad2ad491266f415dfa9715daa",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js": [
        "ce013c289d6413651c8954dd01bf90239ebee316b78a9f0b09076f1868a666fd",
        "02237a9ab1301c042448112eef25e764b6cd10b9b4025efb597f1623d33a1d6f",
      ],
      "node_modules/@earendil-works/pi-codemode/dist/types.d.ts": [
        "f41f5654eec60963557954531167edf5e08661264eb8d6feeaaff6a6835a3ea6",
        "36a8cbe109ef1076bc58d728e2acda6976ea84053d701a1d1b2452ead9d1e63d",
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
