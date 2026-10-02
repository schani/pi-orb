import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { NoSimulationTask } from "determined";
import { openControlPlaneDatabase } from "../../../apps/control-plane/src/adapters/database.ts";
import { fixtureEnvironment, preflightDecision, validateFixture } from "./native-browser-fence.mjs";
import { installFixtureTransport } from "./native-browser-transport.mjs";

const configPath = process.argv[2];
assert(configPath, "usage: node native-browser-main.mjs <nonsecret-config.json>");
const f = JSON.parse(readFileSync(configPath, "utf8"));
validateFixture(f);
assert.deepEqual(
  Object.keys(f).sort(),
  [
    "appOrigin",
    "brokerUrl",
    "computeLog",
    "connectionMap",
    "connectionNonce",
    "gceServiceAccount",
    "gcpProject",
    "generation",
    "orbId",
    "port",
    "projectId",
    "runtimeImageId",
    "runtimeImageResource",
    "subnetwork",
    "workspaceImageId",
    "workspaceImageResource",
    "zone",
  ].sort(),
  "unexpected config key",
);
const state = "/workspace/sol61-preview";
assert(statSync(`${state}/database`).isDirectory());
assert(statSync(`${state}/auth`).isDirectory());
const db = openControlPlaneDatabase({ kind: "pglite", path: `${state}/database` });
assert(db.isOk(), "cannot open existing local authority");
const task = new NoSimulationTask("native browser preflight", false);
try {
  const projects = await db.value.store.listProjects(task);
  assert(projects.isOk(), "cannot inspect projects");
  const entries = [];
  for (const project of projects.value) {
    const orbs = await db.value.store.listOrbsByProject(task, project.id);
    assert(orbs.isOk(), "cannot inspect host references");
    entries.push({ project, orbs: orbs.value });
  }
  globalThis.__nativeBrowserCleanupOnly = preflightDecision(f.projectId, f.orbId, entries);
  if (globalThis.__nativeBrowserCleanupOnly)
    console.error("native-browser: resuming deletion of archived fixture project (cleanup only)");
} finally {
  assert((await db.value.close()).isOk());
}
const planned = fixtureEnvironment(process.env, f, state);
for (const key of Object.keys(process.env)) if (!(key in planned)) delete process.env[key];
Object.assign(process.env, planned);
installFixtureTransport(f);
globalThis.__nativeBrowserFixture = f;
const apiUrl = new URL("../../../apps/control-plane/src/adapters/gce/api.ts", import.meta.url).href;
const scopedUrl = new URL("./native-browser-api.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === apiUrl ? { ...result, url: scopedUrl } : result;
  },
});
const { main } = await import("../../../apps/control-plane/src/main.ts");
await main();
