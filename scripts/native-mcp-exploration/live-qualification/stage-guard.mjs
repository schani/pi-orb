import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sdk = "node_modules/@earendil-works/pi-coding-agent";
const ai = "node_modules/@earendil-works/pi-ai";
const patches = new Map([
  [
    "@earendil-works+pi-agent-core+1.1.0.patch",
    "e817628f707f1d5ea2a3d0d27702919862b23303ba656dea8d30c6412da3e8e1",
  ],
  [
    "@earendil-works+pi-coding-agent+1.1.0.patch",
    "f1d54d120d0de92a0ae119e6588f43fb40114f66a3508fb57547034eddf0161e",
  ],
  [
    "@earendil-works+pi-ai+1.1.0.patch",
    "00c77c3ef2de00b331886971cac1c84f7efd8c68a494b48c7db9128418027a58",
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
    manifest.sourceLockSha,
    sha(join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json")),
  );
  assert.equal(manifest.hostSourceSha, sha(join(root, "apps/orb-runtime/src/mcp/native.ts")));
  assert.equal(manifest.patchHelperSha, sha(join(root, "scripts/apply-dependency-patches.mjs")));
  for (const entry of manifest.patches) {
    assert.equal(entry.sourceSha, sha(join(root, entry.source)), `stale patch: ${entry.source}`);
  }
  return guardInstalledStage(stage, manifest);
}

export async function guardInstalledStage(stage, manifest) {
  stage = resolve(stage);
  assert.equal(manifest.bundleSha, sha(join(stage, "initial-auth.mjs")));
  assert.equal(manifest.patchHelperSha, sha(join(stage, "apply-dependency-patches.mjs")));
  assert.equal(manifest.hostBundleSha, manifest.bundleSha);
  assert.equal(sha(join(stage, "package-lock.json")), manifest.lockSha);
  assert.equal(
    manifest.lockSha,
    "42714b5e7e7bc4536d4ede553726961c11367012127dbcac18586c22b0ef5ea8",
    "qualified lock mismatch",
  );
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
  assert.equal(JSON.parse(readFileSync(join(stage, sdk, "package.json"))).version, "1.1.0");
  assert.equal(JSON.parse(readFileSync(join(stage, ai, "package.json"))).version, "1.1.0");
  assert.equal(manifest.piAiPath, ai);
  for (const artifact of ["dist/extensions/mcp/index.js"]) {
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
  assert.equal(typeof publicSdk.AgentSession.prototype.cancelQueuedCustomSteer, "function");
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
  const mcpPath = realpathSync(join(stage, "node_modules/@earendil-works/pi-mcp/dist/index.js"));
  assert.ok(mcpPath.startsWith(realpathSync(stage) + sep), `pi-mcp escaped stage: ${mcpPath}`);
  const mcp = await import(pathToFileURL(mcpPath).href);
  assert.equal(
    publicSdk.StreamableHttpTransport,
    mcp.StreamableHttpTransport,
    "transport constructor identity changed",
  );
  return { sdkPath: resolved, piAiPath: join(stage, ai) };
}
