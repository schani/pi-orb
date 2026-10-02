import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { sha } from "./iap-read-guard.mjs";

const root = resolve(import.meta.dirname, "../../..");
const local = join(root, "scripts/native-mcp-exploration/live-qualification");
const output = resolve(process.argv[2] ?? "");
assert.ok(output.startsWith(join(root, ".context/iap-consent-20261001") + sep));
await mkdir(output); // Immutable output: existing artifacts cannot be replaced.
const stage = join(output, "staging");
await mkdir(join(stage, "patches"), { recursive: true });
const fixture = JSON.parse(
  await readFile(join(root, ".context/iap-consent-20261001/fixture.json")),
);
assert.equal(fixture.projectId, "4661f85f-e70f-4ccd-b50d-2524496cb02a");
assert.deepEqual(
  fixture.servers.map((s) => [s.name, s.url, s.oauth.id, s.headers]),
  [
    ["cloudflare", "https://mcp.cloudflare.com/mcp", "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b", {}],
    ["datadog", "https://mcp.us5.datadoghq.com/v1/mcp", "c25b1857-1896-45cf-a427-a90cee36d125", {}],
  ],
);
for (const file of ["package.json", "package-lock.json"])
  await cp(join(local, file), join(stage, file));
for (const file of ["iap-read.test.mjs", "iap-read-guard.mjs", "iap-read-preflight.mjs"])
  await cp(join(local, file), join(stage, file));
const patches = [
  "@earendil-works+pi-coding-agent+0.99.1.patch",
  "@earendil-works+pi-coding-agent++@earendil-works+pi-ai+0.99.1.patch",
];
for (const name of patches) await cp(join(root, "patches", name), join(stage, "patches", name));
assert.equal(
  sha(join(stage, "patches", patches[0])),
  "6323a51d57777f235b7b370c53e1fa1afa49418b42fb3d744bc65227036e90a2",
);
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
    join(local, "iap-read.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    ...["@earendil-works/pi-coding-agent", "determined", "neverthrow", "typebox"].map(
      (x) => `--external:${x}`,
    ),
    `--metafile=${join(stage, "bundle-meta.json")}`,
    `--outfile=${join(stage, "iap-read.mjs")}`,
  ],
  root,
  "bundle.log",
);
const files = [
  "package.json",
  "package-lock.json",
  "iap-read.mjs",
  "bundle-meta.json",
  "iap-read.test.mjs",
  "iap-read-guard.mjs",
  "iap-read-preflight.mjs",
  ...patches.map((x) => `patches/${x}`),
];
const manifest = {
  projectId: fixture.projectId,
  fixtureSha: sha(join(root, ".context/iap-consent-20261001/fixture.json")),
  lockSha: sha(join(stage, "package-lock.json")),
  files: Object.fromEntries(files.map((x) => [x, sha(join(stage, x))])),
};
await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
async function install(dir, prefix) {
  await run("npm", ["ci", "--offline", "--ignore-scripts"], dir, `${prefix}-npm-ci.log`);
  await run(
    "node",
    [join(dir, "node_modules/patch-package/index.js"), "--error-on-fail"],
    dir,
    `${prefix}-patch.log`,
  );
  await run("node", ["iap-read-preflight.mjs"], dir, `${prefix}-preflight.log`);
}
await install(stage, "stage");
await run(
  "tar",
  ["-czf", join(output, "iap-read.tgz"), "--exclude=node_modules", "staging"],
  output,
  "archive.log",
);
const isolated = await mkdtemp(join(tmpdir(), "iap-read-archive-"));
assert.ok(!isolated.startsWith(root + sep));
await run("tar", ["-xzf", join(output, "iap-read.tgz"), "-C", isolated], output, "extract.log");
await install(join(isolated, "staging"), "isolated");
const proof = {
  archiveSha: sha(join(output, "iap-read.tgz")),
  isolated,
  fixtureSha: manifest.fixtureSha,
  testCount: 3,
  protocolBundled: true,
};
await writeFile(join(output, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof));
