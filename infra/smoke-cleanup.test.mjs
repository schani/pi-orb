import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./smoke-workload-identity.sh", import.meta.url), "utf8");
const cleanup = source.match(/^cleanup\(\) \{[\s\S]*?^\}/m)?.[0];
assert(cleanup);

for (const status of [0, 1, 143]) {
  for (const disposable of [true, false]) {
    test(`identity cleanup preserves verdict ${status}, disposable=${disposable}`, () => {
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
api() { printf '%s\\n' "$*" >> "$CALL_LOG"; return 7; }
API=api
MINT_ORB=mint-fixture
STOPPED_ORB=stopped-fixture
PROJECT_ID=project-fixture
PROJECT_IS_DISPOSABLE=${disposable}
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
        assert.equal(result.status, status, result.stderr);
        assert.equal(existsSync(work), false, "local credential scratch must always be removed");
        if (status === 0) {
          const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
          assert.deepEqual(calls, [
            "/api/v1/orbs/mint-fixture  DELETE",
            "/api/v1/orbs/stopped-fixture  DELETE",
            ...(disposable ? ["/api/v1/projects/project-fixture  DELETE"] : []),
          ]);
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
