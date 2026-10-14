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
  printf '%s\\n' '{"error":{"code":"not_found"},"httpStatus":404}'
}
API=api
PI_ORB_RELEASE_RECORD=''
MINT_ORB=mint-fixture
STOPPED_ORB=stopped-fixture
PROJECT_ID=project-fixture
PROJECT_IS_DISPOSABLE=${disposable}
START_TS=$(date +%s)
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
          if (status === 0 && !apiFailure)
            assert.match(result.stdout, /WORKLOAD-IDENTITY SMOKE PASSED/);
          else assert.doesNotMatch(result.stdout, /WORKLOAD-IDENTITY SMOKE PASSED/);
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

const apiPath = new URL("./api.sh", import.meta.url).pathname;
const secret = "TOKEN-RAW-BODY-SENTINEL";

function realApi({ authExit = 0, curlExit = 0, http = 200, body = '{"id":"fixture"}' }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-api-"));
  try {
    writeFileSync(
      join(dir, "gcloud"),
      `#!/bin/bash
echo '${secret}' >&2
echo '${secret}'
exit ${authExit}
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/bash
cat >/dev/null
printf '%s\\n' "$*" > "$ARGS_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf '%s' "$FAKE_BODY" > "$1"; fi
  shift
done
echo '${secret}' >&2
printf '%s' '${http}'
exit ${curlExit}
`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [apiPath, "/api/v1/orbs/fixture", "", "DELETE"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PI_ORB_APP_ORIGIN: "https://example.invalid",
        PI_ORB_USER_ID: "",
        ARGS_LOG: join(dir, "args"),
        FAKE_BODY: body,
      },
    });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    if (existsSync(join(dir, "args"))) {
      assert.doesNotMatch(readFileSync(join(dir, "args"), "utf8"), new RegExp(secret));
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, options, exit, diagnostic] of [
  ["auth", { authExit: 9 }, 9, /phase=auth exit=9 errorcode=identity_token/],
  ["transport", { curlExit: 7 }, 7, /phase=transport exit=7 errorcode=curl_transport/],
  [
    "HTTP ingress",
    { http: 403, body: secret },
    22,
    /phase=http exit=22 http=403 errorcode=http_error/,
  ],
  [
    "HTTP application",
    { http: 409, body: `{"error":{"code":"conflict","message":"${secret}"}}` },
    22,
    /phase=http exit=22 http=409 errorcode=application_error/,
  ],
  [
    "200 application",
    { body: `{"error":{"code":"not_found","message":"${secret}"}}` },
    22,
    /phase=application exit=22 http=200 errorcode=application_error/,
  ],
]) {
  test(`real api.sh sanitizes ${name} failures`, () => {
    const result = realApi(options);
    assert.equal(result.status, exit);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, diagnostic);
  });
}

test("real api.sh preserves successful JSON and canonicalizes only HTTP 404 not_found", () => {
  const success = realApi({});
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), { id: "fixture" });
  const missing = realApi({
    http: 404,
    body: `{"error":{"code":"not_found","message":"${secret}"}}`,
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { error: { code: "not_found" }, httpStatus: 404 });
});

for (const [name, api, extra, phase, exit, code] of [
  ["delete request", "return 7", "", "delete", 7, "api_failure"],
  [
    "delete rejection",
    `echo '{"error":{"code":"TOKEN-RAW-BODY-SENTINEL"}}'`,
    "",
    "delete",
    0,
    "application_error",
  ],
  [
    "confirm request",
    `[ "\${3:-}" = DELETE ] && return 0; return 9`,
    "",
    "confirm",
    9,
    "api_failure",
  ],
  [
    "confirm invalid",
    `[ "\${3:-}" = DELETE ] && return 0; echo 'TOKEN-RAW-BODY-SENTINEL'`,
    "",
    "confirm",
    0,
    "invalid_response",
  ],
  [
    "unverified 404",
    `[ "\${3:-}" = DELETE ] && return 0; echo '{"error":{"code":"not_found"}}'`,
    "",
    "confirm",
    0,
    "invalid_response",
  ],
  [
    "confirm deadline",
    `[ "\${3:-}" = DELETE ] && return 0; echo '{"id":"fixture"}'`,
    'date() { if [ -e "$CLOCK_FILE" ]; then echo 301; else touch "$CLOCK_FILE"; echo 0; fi; };',
    "confirm",
    0,
    "deadline",
  ],
  [
    "record failure",
    `[ "\${3:-}" = DELETE ] && return 0; echo '{"error":{"code":"not_found"},"httpStatus":404}'`,
    "fixture_record() { return 6; };",
    "record",
    6,
    "record_failure",
  ],
]) {
  test(`fixture diagnostic: ${name}`, () => {
    // The deadline clock advances on the second call, without sleeping.
    const dir = mkdtempSync(join(tmpdir(), "pi-orb-cleanup-phase-"));
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
PI_ORB_RELEASE_RECORD=''
API=api
api() { ${api}; }
${helpers}
${extra}
fixture_delete orb fixture
`,
        ],
        { encoding: "utf8", env: { ...process.env, CLOCK_FILE: join(dir, "clock") } },
      );
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `Fixture cleanup not confirmed: kind=orb id=fixture phase=${phase} exit=${exit} errorcode=${code}`,
        ),
      );
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("identity complete verdict is emitted only by successful cleanup", () => {
  assert.doesNotMatch(
    source.slice(source.indexOf("# --- preflight")),
    /WORKLOAD-IDENTITY SMOKE PASSED/,
  );
  assert.match(cleanup, /if \[ "\$status" -eq 0 \]; then[\s\S]*WORKLOAD-IDENTITY SMOKE PASSED/);
});
