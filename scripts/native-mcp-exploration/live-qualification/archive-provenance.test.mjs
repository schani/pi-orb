import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { guard as guardGlideos, sha as hash } from "./glideos-read-guard.mjs";
import { guard as guardIap } from "./iap-read-guard.mjs";

const lock = "9a890cc3efd65ff14a142cb6175ab0b46e4d6a0cebea5e66ed4501abdba6c9a8";
const patch = "@earendil-works+pi-coding-agent+1.0.0.patch";
const patchHash = "c684fe6a6a57426521a6fd822ced3636f2004b29eebff3af489e84f59f84c0cf";

test("Glideos rejects a substituted shipped patch even with updated file manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glideos-tamper-"));
  try {
    await mkdir(join(dir, "patches"));
    await writeFile(join(dir, "patches", patch), "altered patch");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        projectId: "35f581fb-7bbf-4542-a1e8-0d047657a71d",
        source: {
          lock,
          vendor: "eb67747b526d862e6bd0c959a330b7897ece86ebed3a21e7cf846730e293e509",
          patches: {
            [patch]: patchHash,
            "@earendil-works+pi-ai+1.0.0.patch":
              "e503e81db607ca52be72d4f1cc67cc1a52c4321212cf4013f569978d08fb9830",
          },
        },
        files: { [`patches/${patch}`]: hash(join(dir, "patches", patch)) },
      }),
    );
    await assert.rejects(guardGlideos(dir), /qualified patch mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("IAP extracted lock resolves the included vendor archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iap-vendor-"));
  try {
    await cp(join(import.meta.dirname, "package-lock.json"), join(dir, "package-lock.json"));
    await writeFile(
      join(dir, "package-lock.json"),
      (await readFile(join(dir, "package-lock.json"), "utf8")).replaceAll(
        "file:../../../vendor/",
        "file:./vendor/",
      ),
    );
    await mkdir(join(dir, "vendor"));
    await writeFile(join(dir, "vendor/pi-coding-agent-1.0.0-brace-5.0.12.tgz"), "altered vendor");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        sourceLockSha: lock,
        lockSha: "fddf8c7ecb31b0786bcacea89adddc6c45ab097a557e65e8c75dc90a16897694",
        files: {},
      }),
    );
    await assert.rejects(guardIap(dir), /vendor archive mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
