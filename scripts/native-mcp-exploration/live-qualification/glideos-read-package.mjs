import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { sha } from "./glideos-read-guard.mjs";

const root = resolve(import.meta.dirname, "../../..");
const local = join(root, "scripts/native-mcp-exploration/live-qualification");
const output = process.argv[2] && resolve(process.argv[2]);
assert.ok(
  output?.startsWith(join(root, ".context/finish-20261001/glideos") + sep),
  "required new owned output directory",
);
await mkdir(output); // Existing attempts are immutable.
const stage = join(output, "staging");
await mkdir(join(stage, "patches"), { recursive: true });
await mkdir(join(stage, "vendor"));
await cp(
  join(root, "scripts/apply-dependency-patches.mjs"),
  join(stage, "apply-dependency-patches.mjs"),
);
const patches = [
  "@earendil-works+pi-coding-agent+1.0.0.patch",
  "@earendil-works+pi-ai+1.0.0.patch",
];
const vendorName = "pi-coding-agent-1.0.0-brace-5.0.12.tgz";
for (const file of [
  "glideos-read.test.mjs",
  "glideos-read-guard.mjs",
  "glideos-read-preflight.mjs",
])
  await cp(join(local, file), join(stage, file));
for (const name of patches) await cp(join(root, "patches", name), join(stage, "patches", name));
await cp(join(root, "vendor", vendorName), join(stage, "vendor", vendorName));
const oldVendor = "file:../../../vendor/" + vendorName;
const newVendor = "file:./vendor/" + vendorName;
for (const file of ["package.json", "package-lock.json"]) {
  const source = await readFile(join(local, file), "utf8");
  assert.ok(source.includes(oldVendor), `missing source vendor reference: ${file}`);
  await writeFile(join(stage, file), source.replaceAll(oldVendor, newVendor));
}
function run(command, args, cwd, log) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: "development", NODE_PATH: "", NODE_OPTIONS: "" },
  });
  return writeFile(
    join(output, log),
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status}\n`,
  ).then(() => assert.equal(result.status, 0, `${log} failed`));
}
await run(
  join(root, "node_modules/.bin/esbuild"),
  [
    join(local, "glideos-read.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    ...["@earendil-works/pi-coding-agent", "determined", "neverthrow", "typebox"].map(
      (x) => `--external:${x}`,
    ),
    `--metafile=${join(stage, "bundle-meta.json")}`,
    `--outfile=${join(stage, "glideos-read.mjs")}`,
  ],
  root,
  "bundle.log",
);
const files = [
  "apply-dependency-patches.mjs",
  "package.json",
  "package-lock.json",
  "glideos-read.mjs",
  "bundle-meta.json",
  "glideos-read.test.mjs",
  "glideos-read-guard.mjs",
  "glideos-read-preflight.mjs",
  `vendor/${vendorName}`,
  ...patches.map((name) => `patches/${name}`),
];
const manifest = {
  projectId: "35f581fb-7bbf-4542-a1e8-0d047657a71d",
  source: {
    lock: sha(join(local, "package-lock.json")),
    package: sha(join(local, "package.json")),
    driver: sha(join(local, "glideos-read.ts")),
    runner: sha(join(local, "runner.ts")),
    protocol: sha(join(root, "packages/protocol/src/mcp.ts")),
    vendor: sha(join(root, "vendor", vendorName)),
    patches: Object.fromEntries(patches.map((name) => [name, sha(join(root, "patches", name))])),
  },
  files: Object.fromEntries(files.map((file) => [file, sha(join(stage, file))])),
};
await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
async function install(dir, prefix) {
  await run("npm", ["ci", "--offline", "--ignore-scripts"], dir, `${prefix}-npm-ci.log`);
  await run(
    "node",
    [join(dir, "apply-dependency-patches.mjs"), "--pi-only"],
    dir,
    `${prefix}-patch.log`,
  );
  await run("node", ["glideos-read-preflight.mjs"], dir, `${prefix}-preflight.log`);
}
await install(stage, "stage");
await run(
  "tar",
  ["-czf", join(output, "glideos-read.tgz"), "--exclude=node_modules", "staging"],
  output,
  "archive.log",
);
const isolated = await mkdtemp(join(tmpdir(), "glideos-read-archive-"));
assert.ok(!isolated.startsWith(root + sep));
await run("tar", ["-xzf", join(output, "glideos-read.tgz"), "-C", isolated], output, "extract.log");
await install(join(isolated, "staging"), "isolated");
const proof = {
  archive: join(output, "glideos-read.tgz"),
  archiveSha: sha(join(output, "glideos-read.tgz")),
  isolated,
  manifestSha: sha(join(stage, "manifest.json")),
  testCount: 4,
  protocolBundled: true,
  guestCommand:
    "EXPECTED_ORB_ID=<owned-orb-id> node staging/glideos-read.mjs cloudflare # or datadog",
};
await writeFile(join(output, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof));
