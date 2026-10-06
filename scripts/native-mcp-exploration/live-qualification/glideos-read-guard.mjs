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
  assert.equal(manifest.projectId, "35f581fb-7bbf-4542-a1e8-0d047657a71d");
  assert.equal(
    manifest.source.lock,
    "88cb750557e7060e8056f00ed7bf778b8acb8e1f53c4aebd8c60da4c6865749f",
  );
  assert.equal(
    manifest.source.vendor,
    "eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509",
  );
  assert.equal(
    manifest.source.patches["@earendil-works+pi-coding-agent+1.0.0.patch"],
    "c684fe6a6a57426521a6fd822ced3636f2004b29eebff3af489e84f59f84c0cf",
  );
  assert.equal(
    manifest.source.patches["@earendil-works+pi-ai+1.0.0.patch"],
    "e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830",
  );
  for (const [name, pinned] of Object.entries(manifest.source.patches))
    assert.equal(sha(join(stage, "patches", name)), pinned, `qualified patch mismatch: ${name}`);
  for (const [file, hash] of Object.entries(manifest.files))
    assert.equal(sha(join(stage, file)), hash, file);
  const lock = JSON.parse(readFileSync(join(stage, "package-lock.json")));
  const vendor = "file:./vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz";
  assert.equal(lock.packages[""].dependencies["@earendil-works/pi-coding-agent"], vendor);
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"].resolved, vendor);
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
    readFileSync(join(stage, "glideos-read.mjs"), "utf8"),
    /(?:from\s*|import\s*\()\s*["']@pi-orb\//,
  );
  assert.doesNotMatch(readFileSync(join(stage, "glideos-read.mjs"), "utf8"), /\brequire\s*\(/);
  const sdk = join(stage, "node_modules/@earendil-works/pi-coding-agent");
  const resolved = realpathSync(join(sdk, "dist/index.js"));
  assert.ok(resolved.startsWith(realpathSync(stage) + sep), "SDK escaped stage");
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
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep), "pi-mcp escaped stage");
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(publicSdk.createMcpExtension, unbundled.createMcpExtension);
  assert.equal(publicSdk.StreamableHttpTransport, mcp.StreamableHttpTransport);
  assert.equal(typeof runtime.McpServerConnection.prototype.waitForOpening, "function");
  assert.equal(typeof publicSdk.createAgentSession, "function");
  assert.equal(typeof publicSdk.DefaultResourceLoader, "function");
  assert.equal(typeof publicSdk.createCodemodeExtension, "function");
  return { status: "pass", sdkVersion: "1.0.0", vendorSha: manifest.source.vendor };
}
