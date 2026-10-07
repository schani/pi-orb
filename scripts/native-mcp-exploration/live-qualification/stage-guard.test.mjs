import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { guardBundle, guardInstalledStage, guardStage, sha } from "./stage-guard.mjs";

const root = resolve(import.meta.dirname, "../../..");
const names = [
  "@earendil-works+pi-coding-agent+1.0.0.patch",
  "@earendil-works+pi-ai+1.0.0.patch",
  "@earendil-works+pi-agent-core+1.0.0.patch",
];

async function fixture() {
  const stage = await mkdtemp(join(tmpdir(), "pi-orb-stage-guard-"));
  await mkdir(join(stage, "patches"));
  await mkdir(join(stage, "vendor"));
  await cp(
    join(root, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz"),
    join(stage, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz"),
  );
  await cp(
    join(root, "scripts/apply-dependency-patches.mjs"),
    join(stage, "apply-dependency-patches.mjs"),
  );
  await writeFile(join(stage, "initial-auth.mjs"), "export const isolated = true;\n");
  await writeFile(join(stage, "bundle-meta.json"), JSON.stringify({ outputs: {} }));
  const sourceLock = readFileSync(
    join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
    "utf8",
  );
  await writeFile(
    join(stage, "package-lock.json"),
    sourceLock.replaceAll("file:../../../vendor/", "file:./vendor/"),
  );
  for (const name of names) await cp(join(root, "patches", name), join(stage, "patches", name));
  const manifest = {
    sourceLockSha: sha(
      join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
    ),
    lockSha: sha(join(stage, "package-lock.json")),
    hostSourceSha: sha(join(root, "apps/orb-runtime/src/mcp/native.ts")),
    bundleSha: sha(join(stage, "initial-auth.mjs")),
    hostBundleSha: sha(join(stage, "initial-auth.mjs")),
    bundleMetaSha: sha(join(stage, "bundle-meta.json")),
    vendorSha: sha(join(stage, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz")),
    patchHelperSha: sha(join(stage, "apply-dependency-patches.mjs")),
    piAiPath: "node_modules/@earendil-works/pi-ai",
    patches: names.map((name) => ({
      source: `patches/${name}`,
      sourceSha: sha(join(root, "patches", name)),
      archiveSha: sha(join(stage, "patches", name)),
    })),
  };
  return { stage, manifest };
}

async function withFixture(run) {
  const { stage, manifest } = await fixture();
  try {
    await run(stage, manifest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

test("bundle cannot import workspace protocol as an external dependency", async () => {
  await withFixture(async (stage) => {
    await writeFile(join(stage, "initial-auth.mjs"), 'import("@pi-orb/protocol");\n');
    await writeFile(
      join(stage, "bundle-meta.json"),
      JSON.stringify({
        outputs: {
          "initial-auth.mjs": {
            entryPoint: "initial-auth.ts",
            imports: [],
            inputs: { "packages/protocol/src/index.ts": {} },
          },
        },
      }),
    );
    assert.throws(() => guardBundle(stage), /workspace protocol escaped bundle/);
  });
});

test("stage rejects a changed SDK patch even when archive and manifest agree", async () => {
  await withFixture(async (stage, manifest) => {
    const file = join(stage, "patches", names[0]);
    await writeFile(file, "changed patch");
    manifest.patches[0].archiveSha = sha(file);
    manifest.patches[0].sourceSha = sha(file);
    await assert.rejects(guardInstalledStage(stage, manifest), /qualified patch mismatch/);
  });
});

test("installed stage rejects a substituted lock and matching mutable manifest", async () => {
  await withFixture(async (stage, manifest) => {
    await writeFile(join(stage, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    manifest.lockSha = sha(join(stage, "package-lock.json"));
    await assert.rejects(guardInstalledStage(stage, manifest), /qualified lock mismatch/);
  });
});

test("stage rejects a substituted core patch even with an updated manifest", async () => {
  await withFixture(async (stage, manifest) => {
    const file = join(stage, "patches", names[2]);
    await writeFile(file, "changed core patch");
    manifest.patches[2].archiveSha = sha(file);
    manifest.patches[2].sourceSha = sha(file);
    await assert.rejects(guardInstalledStage(stage, manifest), /qualified patch mismatch/);
  });
});

test("stage rejects source patch substitution before any install", async () => {
  await withFixture(async (stage, manifest) => {
    manifest.patches[0].sourceSha = "stale";
    await assert.rejects(guardStage(stage, root, manifest), /stale patch/);
  });
});

test("stage rejects SDK resolution outside the isolated install", async () => {
  await withFixture(async (stage, manifest) => {
    await assert.rejects(guardStage(stage, root, manifest), /ENOENT/);
  });
});

test("stage rejects missing native retry hook even when patch digests agree", async () => {
  await withFixture(async (stage, manifest) => {
    const sdk = join(stage, "node_modules/@earendil-works/pi-coding-agent");
    await mkdir(join(sdk, "dist/extensions/mcp"), { recursive: true });
    await mkdir(join(stage, "node_modules/@earendil-works/pi-ai"), { recursive: true });
    await writeFile(join(sdk, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(sdk, "dist/index.js"), "export {};\n");
    await writeFile(
      join(stage, "node_modules/@earendil-works/pi-ai/package.json"),
      '{"version":"1.0.0"}',
    );
    await writeFile(join(sdk, "dist/extensions/mcp/index.js"), "export {};\n");
    await assert.rejects(guardStage(stage, root, manifest), /no retry hook/);
  });
});

test("source lock pin belongs to current standalone installation", () => {
  const current = sha(
    join(root, "scripts/native-mcp-exploration/live-qualification/package-lock.json"),
  );
  for (const file of ["stage-package.mjs", "iap-read-guard.mjs", "glideos-read-guard.mjs"])
    assert.ok(readFileSync(join(import.meta.dirname, file), "utf8").includes(current), file);
});
