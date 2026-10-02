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
    "68238c99112321d5ed0106b9df14e830dcd5513b8775ec73dbc0095d930ff37d",
  );
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
  assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"))).version, "0.99.1");
  assert.equal(
    JSON.parse(readFileSync(join(sdk, "node_modules/@earendil-works/pi-ai/package.json"))).version,
    "0.99.1",
  );
  for (const file of ["dist/extensions/mcp/index.js", "dist/bundle/chunks/chunk-GUORCHFS.js"]) {
    const code = readFileSync(join(sdk, file), "utf8");
    assert.match(code, /retryConnectionOnPrompt/);
    assert.match(code, /waitForOpening/);
  }
  const publicSdk = await import(pathToFileURL(resolved).href);
  const unbundled = await import(pathToFileURL(join(sdk, "dist/extensions/mcp/index.js")).href);
  const runtime = await import(pathToFileURL(join(sdk, "dist/extensions/mcp/runtime.js")).href);
  const mcpPath = realpathSync(join(sdk, "node_modules/@earendil-works/pi-mcp/dist/index.js"));
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep));
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(publicSdk.createMcpExtension, unbundled.createMcpExtension);
  assert.equal(publicSdk.StreamableHttpTransport, mcp.StreamableHttpTransport);
  assert.equal(typeof runtime.McpServerConnection.prototype.waitForOpening, "function");
  return {
    status: "pass",
    sdkVersion: "0.99.1",
    patchHash: manifest.files["patches/@earendil-works+pi-coding-agent+0.99.1.patch"],
  };
}
