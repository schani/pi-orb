import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { guardBundle, guardInstalledStage, guardStage, sha } from "./stage-guard.mjs";

test("reject prior bundle with external workspace protocol despite current host code", () => {
  assert.throws(
    () => guardBundle(join(root, ".context/dedicated-oauth-reauthorization/corrected/staging")),
    /workspace protocol escaped bundle/,
  );
});

const root = resolve(import.meta.dirname, "../../..");
const old = join(root, ".context/dedicated-oauth-reauthorization/staging");
const patchNames = [
  "@earendil-works+pi-coding-agent+0.99.1.patch",
  "@earendil-works+pi-coding-agent++@earendil-works+pi-ai+0.99.1.patch",
];
test("live stage and IAP guards pin the current isolated lock, not the archived staging lock", () => {
  const current = sha(
    join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
  );
  const archived = "8154b305f4889bdd70ca18ef4c186b9b6d1774ab8b624ed548c3fa152dae1bf8";
  assert.notEqual(current, archived);
  for (const file of ["stage-package.mjs", "iap-read-guard.mjs"]) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    assert.ok(source.includes(`"${current}"`), `${file}: current lock pin missing`);
    assert.ok(!source.includes(`"${archived}"`), `${file}: archived lock accepted`);
  }
});

const manifest = (stage) => ({
  lockSha: sha(join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json")),
  hostSourceSha: sha(join(root, "apps/orb-runtime/src/mcp/native.ts")),
  bundleSha: sha(join(stage, "initial-auth.mjs")),
  hostBundleSha: sha(join(stage, "initial-auth.mjs")),
  piAiPath: "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  patches: patchNames.map((name) => ({
    source: `patches/${name}`,
    sourceSha: sha(join(root, "patches", name)),
    archiveSha: sha(join(stage, "patches", name)),
  })),
});

test("reject a changed qualified patch even when archive and manifest agree", async () => {
  const stage = await mkdtemp(join(root, ".stage-guard-"));
  try {
    await mkdir(join(stage, "patches"));
    await cp(join(old, "initial-auth.mjs"), join(stage, "initial-auth.mjs"));
    await cp(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
      join(stage, "package-lock.json"),
    );
    const changed = join(stage, "patches", patchNames[0]);
    await writeFile(changed, "changed qualified patch");
    const patches = [
      { source: `patches/${patchNames[0]}`, sourceSha: sha(changed), archiveSha: sha(changed) },
      {
        source: `patches/${patchNames[1]}`,
        sourceSha: sha(join(root, "patches", patchNames[1])),
        archiveSha: sha(join(root, "patches", patchNames[1])),
      },
    ];
    await cp(join(root, "patches", patchNames[1]), join(stage, "patches", patchNames[1]));
    await assert.rejects(
      guardInstalledStage(stage, {
        ...manifest(old),
        lockSha: sha(join(stage, "package-lock.json")),
        patches,
      }),
      /qualified patch mismatch/,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("reject obsolete SDK patch even when version and host bundle are current", async () => {
  const stage = await mkdtemp(join(root, ".stage-guard-"));
  try {
    await mkdir(join(stage, "patches"));
    await cp(join(old, "initial-auth.mjs"), join(stage, "initial-auth.mjs"));
    await cp(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
      join(stage, "package-lock.json"),
    );
    for (const name of patchNames)
      await cp(join(old, "patches", name), join(stage, "patches", name));
    await assert.rejects(
      guardStage(stage, root, manifest(stage)),
      (error) =>
        error.actual === sha(join(old, "patches", patchNames[0])) &&
        error.expected === sha(join(root, "patches", patchNames[0])),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("reject SDK resolution outside isolated stage (never fall back to root)", async () => {
  const stage = await mkdtemp(join(import.meta.dirname, ".fallback-"));
  try {
    await cp(join(old, "initial-auth.mjs"), join(stage, "initial-auth.mjs"));
    await cp(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
      join(stage, "package-lock.json"),
    );
    await mkdir(join(stage, "patches"));
    for (const name of patchNames)
      await cp(join(root, "patches", name), join(stage, "patches", name));
    await assert.rejects(guardStage(stage, root, manifest(stage)), /ENOENT/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("reject missing bundled retry hook after unbundled module is patched", async () => {
  const stage = await mkdtemp(join(root, ".stage-guard-"));
  try {
    await cp(join(old, "initial-auth.mjs"), join(stage, "initial-auth.mjs"));
    await cp(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
      join(stage, "package-lock.json"),
    );
    await cp(
      join(old, "node_modules/@earendil-works"),
      join(stage, "node_modules/@earendil-works"),
      { recursive: true },
    );
    await mkdir(join(stage, "patches"));
    for (const name of patchNames)
      await cp(join(root, "patches", name), join(stage, "patches", name));
    const sdk = join(stage, "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp");
    await cp(
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js"),
      join(sdk, "index.js"),
    );
    await cp(
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js"),
      join(sdk, "runtime.js"),
    );
    await assert.rejects(guardStage(stage, root, manifest(stage)), /no retry hook: dist\/bundle/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
