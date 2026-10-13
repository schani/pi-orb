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
    "42714b5e7e7bc4536d4ede553726961c11367012127dbcac18586c22b0ef5ea8",
  );
  assert.equal(
    manifest.source.patches["@earendil-works+pi-coding-agent+1.1.0.patch"],
    "f1d54d120d0de92a0ae119e6588f43fb40114f66a3508fb57547034eddf0161e",
  );
  assert.deepEqual(Object.keys(manifest.source.patches).sort(), [
    "@earendil-works+pi-agent-core+1.1.0.patch",
    "@earendil-works+pi-ai+1.1.0.patch",
    "@earendil-works+pi-coding-agent+1.1.0.patch",
  ]);
  assert.equal(
    manifest.source.patches["@earendil-works+pi-agent-core+1.1.0.patch"],
    "e817628f707f1d5ea2a3d0d27702919862b23303ba656dea8d30c6412da3e8e1",
  );
  assert.equal(
    manifest.source.patches["@earendil-works+pi-ai+1.1.0.patch"],
    "812225636f3c081e6e8497b0b7c98051baedea90b455f6e7f837ccc5a84be9c7",
  );
  for (const [name, pinned] of Object.entries(manifest.source.patches))
    assert.equal(sha(join(stage, "patches", name)), pinned, `qualified patch mismatch: ${name}`);
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
    readFileSync(join(stage, "glideos-read.mjs"), "utf8"),
    /(?:from\s*|import\s*\()\s*["']@pi-orb\//,
  );
  assert.doesNotMatch(readFileSync(join(stage, "glideos-read.mjs"), "utf8"), /\brequire\s*\(/);
  const sdk = join(stage, "node_modules/@earendil-works/pi-coding-agent");
  const resolved = realpathSync(join(sdk, "dist/index.js"));
  assert.ok(resolved.startsWith(realpathSync(stage) + sep), "SDK escaped stage");
  assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"))).version, "1.1.0");
  assert.equal(
    JSON.parse(readFileSync(join(stage, "node_modules/@earendil-works/pi-ai/package.json")))
      .version,
    "1.1.0",
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
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep), "pi-mcp escaped stage");
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(publicSdk.createMcpExtension, unbundled.createMcpExtension);
  assert.equal(publicSdk.StreamableHttpTransport, mcp.StreamableHttpTransport);
  assert.equal(typeof runtime.McpServerConnection.prototype.waitForOpening, "function");
  assert.equal(typeof publicSdk.createAgentSession, "function");
  assert.equal(typeof publicSdk.DefaultResourceLoader, "function");
  assert.equal(typeof publicSdk.createCodemodeExtension, "function");
  return { status: "pass", sdkVersion: "1.1.0" };
}
