import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./smoke-workload-identity.sh", import.meta.url), "utf8");
const cleanup = source.match(/^cleanup\(\) \{[\s\S]*?^\}/m)?.[0];
const helpers = readFileSync(new URL("./smoke-fixtures.sh", import.meta.url), "utf8");
assert(cleanup);

for (const status of [0, 1, 143]) {
  for (const disposable of [true, false]) {
    for (const apiFailure of [true, false]) {
      test(`identity cleanup: verdict=${status}, disposable=${disposable}, API failure=${apiFailure}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-orb-smoke-cleanup-"));
        const work = join(dir, "credentials");
        writeFileSync(work, "non-secret-test-sentinel");
        try {
          const result = spawnSync(
            "bash",
            [
              "-c",
              `
set -euo pipefail
api() {
  printf '%s\\n' "$*" >> "$CALL_LOG"
  if ${apiFailure}; then return 7; fi
  printf '%s\\n' '{"error":{"code":"not_found"}}'
}
API=api
PI_ORB_RELEASE_RECORD=''
MINT_ORB=mint-fixture
STOPPED_ORB=stopped-fixture
PROJECT_ID=project-fixture
PROJECT_IS_DISPOSABLE=${disposable}
${helpers}
${cleanup}
trap cleanup EXIT
exit ${status}
`,
            ],
            {
              encoding: "utf8",
              env: { ...process.env, WORK_DIR: work, CALL_LOG: join(dir, "calls") },
            },
          );
          assert.equal(result.status, status === 0 && apiFailure ? 1 : status, result.stderr);
          assert.equal(existsSync(work), false, "credential scratch must always be removed");
          if (status === 0) {
            const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
            const subjects = [
              "orbs/mint-fixture",
              "orbs/stopped-fixture",
              ...(disposable && !apiFailure ? ["projects/project-fixture"] : []),
            ];
            assert.deepEqual(
              calls,
              subjects.flatMap((subject) => [
                `/api/v1/${subject}  DELETE`,
                ...(!apiFailure ? [`/api/v1/${subject}`] : []),
              ]),
            );
          } else {
            assert.equal(existsSync(join(dir, "calls")), false);
            assert.match(result.stderr, /Failed fixtures retained/);
            assert.match(result.stderr, /compute\/storage charges/);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}
