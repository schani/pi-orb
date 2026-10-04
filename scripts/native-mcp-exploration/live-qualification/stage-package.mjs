import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { guardStage, sha } from "./stage-guard.mjs";

const root = resolve(import.meta.dirname, "../../..");
const local = join(root, "scripts/native-mcp-exploration/live-qualification");
const output = process.argv[2] && resolve(process.argv[2]);
assert.ok(
  output?.startsWith(join(root, ".context/dedicated-oauth-reauthorization") + sep),
  "required new owned output directory",
);
await mkdir(output); // Refuse to overwrite evidence.
const stage = join(output, "staging");
const lockSha = sha(join(local, "package-lock.json"));
assert.equal(lockSha, "d23afb6b1e2750426ef59f4cba18808485345759e7c54e57679e9399585db53c");
const names = ["@earendil-works+pi-coding-agent+1.0.0.patch", "@earendil-works+pi-ai+1.0.0.patch"];
function run(command, args, cwd, log, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: "development", ...env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  const text = `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status}\n`;
  writeFileSync(join(output, log), text);
  if (result.status !== 0) throw new Error(text);
  return result.stdout;
}
async function install(dir, prefix) {
  run("npm", ["ci", "--ignore-scripts"], dir, `${prefix}-npm-ci.log`);
  const graph = JSON.parse(await readFile(join(dir, "package-lock.json")));
  const aiPath = "node_modules/@earendil-works/pi-ai";
  assert.equal(graph.packages[aiPath]?.version, "1.0.0");
  run(
    "node",
    [join(dir, "node_modules/patch-package/index.js"), "--error-on-fail"],
    dir,
    `${prefix}-patch.log`,
  );
}
await mkdir(join(stage, "patches"), { recursive: true });
for (const file of [
  "package.json",
  "package-lock.json",
  "initial-auth.test.mjs",
  "stage-guard.mjs",
  "preflight.mjs",
])
  await cp(join(local, file), join(stage, file));
for (const name of names) await cp(join(root, "patches", name), join(stage, "patches", name));
const vendor = "pi-coding-agent-1.0.0-brace-5.0.12.tgz";
await mkdir(join(stage, "vendor"));
const patchPackage = "patch-package-8.0.1-orb.1.tgz";
for (const archive of [vendor, patchPackage])
  await cp(join(root, "vendor", archive), join(stage, "vendor", archive));
for (const file of ["package.json", "package-lock.json"]) {
  const path = join(stage, file);
  let source = await readFile(path, "utf8");
  for (const archive of [vendor, patchPackage]) {
    const original = `file:../../../vendor/${archive}`;
    assert.ok(source.includes(original), `missing vendor reference: ${file}: ${archive}`);
    source = source.replaceAll(original, `file:./vendor/${archive}`);
  }
  await writeFile(path, source);
}
run(
  join(root, "node_modules/.bin/esbuild"),
  [
    join(local, "initial-auth.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    ...["@earendil-works/pi-coding-agent", "determined", "neverthrow", "typebox"].map(
      (name) => `--external:${name}`,
    ),
    `--metafile=${join(stage, "bundle-meta.json")}`,
    `--outfile=${join(stage, "initial-auth.mjs")}`,
  ],
  root,
  "bundle.log",
);
const manifest = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  ),
  hostSourceSha: sha(join(root, "apps/orb-runtime/src/mcp/native.ts")),
  hostBundleSha: sha(join(stage, "initial-auth.mjs")),
  bundleSha: sha(join(stage, "initial-auth.mjs")),
  bundleMetaSha: sha(join(stage, "bundle-meta.json")),
  sourceLockSha: lockSha,
  lockSha: sha(join(stage, "package-lock.json")),
  vendorSha: sha(join(root, "vendor", vendor)),
  patchPackageSha: sha(join(root, "vendor", patchPackage)),
  piAiPath: "node_modules/@earendil-works/pi-ai",
  patches: names.map((name) => ({
    source: `patches/${name}`,
    sourceSha: sha(join(root, "patches", name)),
    archiveSha: sha(join(stage, "patches", name)),
  })),
};
await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await install(stage, "stage");
console.log("stage SDK:", await guardStage(stage, root, manifest));
run("node", ["preflight.mjs"], stage, "stage-functional.log");
run(
  "tar",
  ["-czf", join(output, "guest-stage.tgz"), "--exclude=node_modules", "staging"],
  output,
  "archive.log",
);
const isolated = await mkdtemp(join(tmpdir(), "native-mcp-archive-preflight-"));
assert.ok(!isolated.startsWith(root + sep), "preflight must run outside checkout");
run("tar", ["-xzf", join(output, "guest-stage.tgz"), "-C", isolated], output, "extract.log");
const archived = join(isolated, "staging");
await install(archived, "isolated");
console.log("isolated SDK:", await guardStage(archived, root, manifest));
run("node", ["preflight.mjs"], archived, "isolated-functional.log");
const proof = {
  isolated,
  archiveSha: sha(join(output, "guest-stage.tgz")),
  sdk: join(archived, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  protocolBundled: true,
  initialAuth: "pass",
};
await writeFile(join(output, "preflight.json"), `${JSON.stringify(proof, null, 2)}\n`);
console.log(proof);
