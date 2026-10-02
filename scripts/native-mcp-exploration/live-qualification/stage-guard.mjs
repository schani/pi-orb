import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sdk = "node_modules/@earendil-works/pi-coding-agent";
const ai = `${sdk}/node_modules/@earendil-works/pi-ai`;
const patches = new Map([
  [
    "@earendil-works+pi-coding-agent+0.99.1.patch",
    "6323a51d57777f235b7b370c53e1fa1afa49418b42fb3d744bc65227036e90a2",
  ],
  [
    "@earendil-works+pi-coding-agent++@earendil-works+pi-ai+0.99.1.patch",
    "9940265eeb7a26235acb5685442894b7fc761b31e8aca21d3971409dd4029938",
  ],
]);

const allowed = new Set([
  "@earendil-works/pi-coding-agent",
  "determined",
  "neverthrow",
  "typebox",
  "typebox/value",
]);

export function guardBundle(stage) {
  const bundle = readFileSync(join(stage, "initial-auth.mjs"), "utf8");
  assert.doesNotMatch(
    bundle,
    /(?:from\s*|import\s*\()\s*["']@pi-orb\//,
    "workspace protocol escaped bundle",
  );
  const meta = JSON.parse(readFileSync(join(stage, "bundle-meta.json")));
  const outputs = Object.values(meta.outputs).filter((entry) => entry.entryPoint);
  assert.equal(outputs.length, 1);
  for (const dependency of outputs[0].imports) {
    if (!dependency.external) continue;
    const name = dependency.path;
    assert.ok(
      allowed.has(name) || builtinModules.includes(name) || name.startsWith("node:"),
      `unapproved external: ${name}`,
    );
  }
  assert.ok(
    Object.keys(outputs[0].inputs).some((name) => name.includes("packages/protocol/src/")),
    "protocol not bundled",
  );
}

export async function guardStage(stage, root, manifest) {
  stage = resolve(stage);
  root = resolve(root);
  assert.equal(
    manifest.lockSha,
    sha(join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json")),
  );
  assert.equal(manifest.hostSourceSha, sha(join(root, "apps/orb-runtime/src/mcp/native.ts")));
  for (const entry of manifest.patches) {
    assert.equal(entry.sourceSha, sha(join(root, entry.source)), `stale patch: ${entry.source}`);
  }
  return guardInstalledStage(stage, manifest);
}

export async function guardInstalledStage(stage, manifest) {
  stage = resolve(stage);
  assert.equal(
    manifest.lockSha,
    "68238c99112321d5ed0106b9df14e830dcd5513b8775ec73dbc0095d930ff37d",
  );
  assert.equal(manifest.bundleSha, sha(join(stage, "initial-auth.mjs")));
  assert.equal(manifest.hostBundleSha, manifest.bundleSha);
  assert.equal(sha(join(stage, "package-lock.json")), manifest.lockSha);
  assert.equal(manifest.patches.length, patches.size);
  for (const [name, qualifiedSha] of patches) {
    const entry = manifest.patches.find((p) => p.source === `patches/${name}`);
    assert.ok(entry, `missing applied patch: ${name}`);
    assert.equal(
      entry.archiveSha,
      sha(join(stage, "patches", name)),
      `archive patch mismatch: ${name}`,
    );
    assert.equal(entry.archiveSha, entry.sourceSha);
    assert.equal(entry.archiveSha, qualifiedSha, `qualified patch mismatch: ${name}`);
  }
  const resolved = realpathSync(join(stage, sdk, "dist/index.js"));
  assert.ok(resolved.startsWith(realpathSync(stage) + sep), `SDK escaped stage: ${resolved}`);
  assert.equal(JSON.parse(readFileSync(join(stage, sdk, "package.json"))).version, "0.99.1");
  assert.equal(JSON.parse(readFileSync(join(stage, ai, "package.json"))).version, "0.99.1");
  assert.equal(manifest.piAiPath, ai);
  for (const artifact of ["dist/extensions/mcp/index.js", "dist/bundle/chunks/chunk-GUORCHFS.js"]) {
    const text = readFileSync(join(stage, sdk, artifact), "utf8");
    assert.match(text, /retryConnectionOnPrompt/, `no retry hook: ${artifact}`);
    assert.match(text, /waitForOpening/, `no opening wait: ${artifact}`);
  }
  assert.match(
    readFileSync(join(stage, sdk, "dist/extensions/mcp/runtime.js"), "utf8"),
    /waitForOpening/,
  );
  assert.equal(manifest.bundleMetaSha, sha(join(stage, "bundle-meta.json")));
  guardBundle(stage);
  const publicSdk = await import(pathToFileURL(resolved).href);
  const unbundled = await import(
    pathToFileURL(join(stage, sdk, "dist/extensions/mcp/index.js")).href
  );
  const runtime = await import(
    pathToFileURL(join(stage, sdk, "dist/extensions/mcp/runtime.js")).href
  );
  assert.equal(typeof publicSdk.createAgentSession, "function");
  assert.equal(typeof publicSdk.DefaultResourceLoader, "function");
  assert.equal(
    publicSdk.createMcpExtension,
    unbundled.createMcpExtension,
    "public MCP factory identity changed",
  );
  assert.equal(typeof runtime.McpServerConnection.prototype.waitForOpening, "function");
  const mcpPath = realpathSync(
    join(stage, sdk, "node_modules/@earendil-works/pi-mcp/dist/index.js"),
  );
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep), `pi-mcp escaped stage: ${mcpPath}`);
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(
    publicSdk.StreamableHttpTransport,
    mcp.StreamableHttpTransport,
    "transport constructor identity changed",
  );
  return { sdkPath: resolved, piAiPath: join(stage, ai) };
}
