import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
export const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export async function guard(stage) {
  stage = resolve(stage);
  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json")));
  assert.equal(
    manifest.lockSha,
    "c926b9531fe1cc4c59269e852bdc79582db339f335228487cd39d1b26a402abe",
  );
  assert.equal(
    manifest.sourceLockSha,
    "d23afb6b1e2750426ef59f4cba18808485345759e7c54e57679e9399585db53c",
  );
  const vendor = "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz";
  assert.equal(
    sha(join(stage, vendor)),
    "eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509",
    "vendor archive mismatch",
  );
  assert.equal(
    manifest.files[vendor],
    sha(join(stage, vendor)),
    "vendor archive missing from manifest",
  );
  const lock = JSON.parse(readFileSync(join(stage, "package-lock.json")));
  const reference = `file:./${vendor}`;
  assert.equal(
    lock.packages[""].dependencies["@earendil-works/pi-coding-agent"],
    reference,
    "vendor reference mismatch",
  );
  assert.equal(
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].resolved,
    reference,
    "vendor reference mismatch",
  );
  const patchPackage = "vendor/patch-package-8.0.1-orb.1.tgz";
  assert.equal(
    sha(join(stage, patchPackage)),
    "8f29fbb091eefde2bc96a871c540b155afc9e0bfd52f0908d1180e3ee904d41f",
    "patch-package archive mismatch",
  );
  assert.equal(
    manifest.files[patchPackage],
    sha(join(stage, patchPackage)),
    "patch-package archive missing from manifest",
  );
  assert.equal(lock.packages[""].dependencies["patch-package"], `file:./${patchPackage}`);
  assert.equal(lock.packages["node_modules/patch-package"].resolved, `file:./${patchPackage}`);
  assert.equal(sha(join(stage, "package-lock.json")), manifest.lockSha);
  for (const [file, hash] of Object.entries(manifest.files))
    assert.equal(sha(join(stage, file)), hash, file);
  const meta = JSON.parse(readFileSync(join(stage, "bundle-meta.json")));
  const entries = Object.values(meta.outputs).filter((x) => x.entryPoint);
  assert.equal(entries.length, 1);
  assert.ok(Object.keys(entries[0].inputs).some((x) => x.includes("packages/protocol/src/")));
  const allowed = new Set([
    "@earendil-works/pi-coding-agent",
    "determined",
    "neverthrow",
    "typebox",
    "typebox/value",
  ]);
  for (const dep of entries[0].imports)
    if (dep.external)
      assert.ok(
        allowed.has(dep.path) || dep.path.startsWith("node:") || builtinModules.includes(dep.path),
        `external ${dep.path}`,
      );
  assert.doesNotMatch(
    readFileSync(join(stage, "iap-read.mjs"), "utf8"),
    /(?:from\s*|import\s*\()\s*["']@pi-orb\//,
  );
  const sdk = join(stage, "node_modules/@earendil-works/pi-coding-agent");
  const resolved = realpathSync(join(sdk, "dist/index.js"));
  assert.ok(resolved.startsWith(realpathSync(stage) + sep));
  assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"))).version, "1.0.0");
  assert.equal(
    JSON.parse(readFileSync(join(stage, "node_modules/@earendil-works/pi-ai/package.json")))
      .version,
    "1.0.0",
  );
  for (const file of ["dist/extensions/mcp/index.js"]) {
    const code = readFileSync(join(sdk, file), "utf8");
    assert.match(code, /retryConnectionOnPrompt/);
    assert.match(code, /waitForOpening/);
  }
  const publicSdk = await import(pathToFileURL(resolved).href);
  const unbundled = await import(pathToFileURL(join(sdk, "dist/extensions/mcp/index.js")).href);
  const runtime = await import(pathToFileURL(join(sdk, "dist/extensions/mcp/runtime.js")).href);
  const mcpPath = realpathSync(join(stage, "node_modules/@earendil-works/pi-mcp/dist/index.js"));
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep));
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(publicSdk.createMcpExtension, unbundled.createMcpExtension);
  assert.equal(publicSdk.StreamableHttpTransport, mcp.StreamableHttpTransport);
  assert.equal(typeof runtime.McpServerConnection.prototype.waitForOpening, "function");
  return {
    status: "pass",
    sdkVersion: "1.0.0",
    patchHash: manifest.files["patches/@earendil-works+pi-coding-agent+1.0.0.patch"],
  };
}
