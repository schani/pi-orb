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
    "ad895afd6cbf53cef4e1385065fe8620e008a3ed3a4cf5bcf15e7ae7e863dcf4",
  );
  assert.equal(
    manifest.sourceLockSha,
    "88cb750557e7060e8056f00ed7bf778b8acb8e1f53c4aebd8c60da4c6865749f",
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
  assert.equal(sha(join(stage, "package-lock.json")), manifest.lockSha);
  const patches = {
    "@earendil-works+pi-agent-core+1.0.0.patch":
      "7e2c5e2d68d97419c086ac5d369f6d2b83be2020a3be062e1a1402b37ab0cdb2",
    "@earendil-works+pi-ai+1.0.0.patch":
      "e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830",
    "@earendil-works+pi-coding-agent+1.0.0.patch":
      "a7eda2ad337b150f45f2516ee2b77a159cd081f68a16479b61ba48ee68b9fc73",
  };
  assert.deepEqual(
    Object.keys(manifest.files)
      .filter((file) => file.startsWith("patches/"))
      .sort(),
    Object.keys(patches)
      .map((name) => `patches/${name}`)
      .sort(),
  );
  for (const [name, pinned] of Object.entries(patches)) {
    const file = `patches/${name}`;
    assert.equal(manifest.files[file], pinned, `qualified patch mismatch: ${name}`);
    assert.equal(sha(join(stage, file)), pinned, `qualified patch mismatch: ${name}`);
  }
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
  assert.equal(typeof publicSdk.AgentSession.prototype.cancelQueuedCustomSteer, "function");
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
