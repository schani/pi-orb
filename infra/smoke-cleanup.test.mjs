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
          if (status === 0 && !apiFailure) {
            assert.match(result.stdout, /WORKLOAD-IDENTITY SMOKE PASSED/);
          } else {
            assert.doesNotMatch(result.stdout, /SMOKE PASSED/);
            assert.match(result.stderr, /compute\/storage charges/);
          }
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

test("lifecycle partial cleanup never relabels a verified-deleted project retained", () => {
  const lifecycle = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");
  const cleanup = lifecycle.match(/^cleanup\(\) \{[\s\S]*?^\}/m)[0];
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
PROJECT_ID=owned-project
ORB_ID=owned-orb
fixture_delete() { echo "delete:$*"; [ "$1" = project ]; }
fixture_record() { echo "record:$*"; }
${cleanup}
trap cleanup EXIT
exit 0
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /delete:project owned-project/);
  assert.match(result.stdout, /delete:orb owned-orb/);
  assert.match(result.stdout, /record:orb owned-orb retained/);
  assert.doesNotMatch(result.stdout, /record:project|SMOKE PASSED/);
  assert.match(result.stderr, /owned-orb.*compute\/storage charges/);
});

for (const kind of ["lifecycle", "identity-shared", "identity-disposable"]) {
  test(`${kind}: verified absence survives record failure without PASS`, () => {
    const identity = kind !== "lifecycle";
    const source = readFileSync(
      new URL(identity ? "./smoke-workload-identity.sh" : "./smoke.sh", import.meta.url),
      "utf8",
    );
    const cleanup = source.match(/^cleanup\(\) \{[\s\S]*?^\}/m)[0];
    const dir = mkdtempSync(join(tmpdir(), "pi-orb-record-cleanup-"));
    const work = join(dir, "credentials");
    writeFileSync(work, "credential-sentinel");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
${helpers}
fixture_record() { echo "record:$*"; [ "$3" != deleted ]; }
api() { printf '%s' '{"error":{"code":"not_found"}}'; }
API=api
PROJECT_ID=owned-project
ORB_ID=owned-orb
MINT_ORB=owned-mint
STOPPED_ORB=owned-stopped
PROJECT_IS_DISPOSABLE=${kind === "identity-disposable"}
${cleanup}
trap cleanup EXIT
exit 0
`,
        ],
        { encoding: "utf8", env: { ...process.env, WORK_DIR: work } },
      );
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /SMOKE PASSED/);
      assert.match(result.stderr, /phase=record outcome=failed/);
      assert.doesNotMatch(result.stdout, /record:orb .* retained/);
      if (kind === "identity-disposable") {
        assert.match(result.stdout, /record:project owned-project retained/);
        assert.match(result.stderr, /compute\/storage charges/);
      } else {
        assert.doesNotMatch(result.stdout, /record:project .* retained/);
        assert.doesNotMatch(result.stderr, /compute\/storage charges/);
      }
      if (identity) assert.equal(existsSync(work), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [view, command, accepted] of [
  ['{"state":"running"}', "{}", true],
  ['{"state":"failed"}', "{}", false],
  ["{}", "{}", false],
  ["not-json", "{}", false],
  ['{"state":"running"}', '{"error":{"code":"conflict"}}', false],
]) {
  test(`shared lifecycle mechanics refuse invalid evidence: ${view} / ${command}`, () => {
    const result = spawnSync(
      "bash",
      [
        "-ec",
        `
      ${helpers}
      DEADLINE=$(( $(date +%s) + 60 ))
      say() { :; }
      smoke_lifecycle_fail() { echo "$*" >&2; exit 9; }
      api() { case "$1" in */stop) printf '%s' '${command}';; *) printf '%s' '${view}';; esac; }
      smoke_wait_for_state fixture running 30 step
      smoke_command_orb fixture stop
    `,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    assert.equal(result.status, accepted ? 0 : 9, result.stderr);
  });
}
