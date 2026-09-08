import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./adopt.sh", import.meta.url).pathname;

function fixture(directory) {
  const state = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "app",
    outputs: {},
    resources: [
      {
        mode: "managed",
        type: "google_service_account",
        name: "orb_vm",
        provider: "provider",
        instances: [{ schema_version: 0, attributes: { id: "sa" } }],
      },
    ],
  };
  writeFileSync(join(directory, "app.tfstate"), JSON.stringify(state));
  const bin = directory;
  writeFileSync(
    join(directory, "gcloud"),
    `#!/usr/bin/env node
const fs=require('fs'); const a=process.argv.slice(2); fs.appendFileSync(process.env.CALLS, JSON.stringify(a)+'\\n');
if(a[0]==='projects'){process.stdout.write('123\\n');process.exit(0)}
if(a[1]==='objects'&&a[2]==='describe'){if(a[3].includes('foundation')){process.stderr.write('404 not found\\n');process.exit(1)} process.stdout.write(a[3].includes('release.lock')?'22\\n':'11\\n');process.exit(0)}
if(a[1]==='cp'&&a[2].includes('static-plane/default.tfstate#')){fs.copyFileSync(process.env.APP_STATE,a[3]);process.exit(0)}
if(a[1]==='cp'){process.exit(0)}
if(a[1]==='rm'){process.exit(0)}
process.exit(1)
`,
  );
  chmodSync(join(directory, "gcloud"), 0o755);
  return { bin, calls: join(directory, "calls"), state: join(directory, "app.tfstate") };
}

test("dry run reads an exact generation and performs no upload", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundation-adopt-test-"));
  const f = fixture(directory);
  const result = spawnSync(script, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      CALLS: f.calls,
      APP_STATE: f.state,
      TMPDIR: directory,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert(calls.some((call) => call[1] === "cp" && call[2].endsWith("#11")));
  assert(!calls.some((call) => call[1] === "cp" && call.includes("--if-generation-match=0")));
});

test("execute pushes foundation before application with generation guards", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundation-adopt-test-"));
  const f = fixture(directory);
  const result = spawnSync(script, ["--execute"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      CALLS: f.calls,
      APP_STATE: f.state,
      TMPDIR: directory,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  const uploads = calls.filter((call) => call[1] === "cp" && call[2].endsWith(".tfstate"));
  assert(uploads[0][3].includes("foundation/default.tfstate"));
  assert(uploads[0].includes("--if-generation-match=0"));
  assert(uploads[1][3].includes("static-plane/default.tfstate"));
  assert(uploads[1].includes("--if-generation-match=11"));
});
