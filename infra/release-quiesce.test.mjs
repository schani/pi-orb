import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const helper = new URL("./release-quiesce.sh", import.meta.url).pathname;
const childLibrary = new URL("./release-child.sh", import.meta.url).pathname;

function fixture({
  metrics = "zero",
  mode = "automatic",
  deploy = "success",
  restoreFails = false,
  tag = false,
  traffic = "sole",
  latest = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-quiesce-test-"));
  const log = join(dir, "calls.log");
  const service = {
    metadata: {
      annotations:
        mode === "manual"
          ? {
              "run.googleapis.com/scalingMode": "manual",
              "run.googleapis.com/manualInstanceCount": "2",
            }
          : { "run.googleapis.com/scalingMode": "automatic" },
    },
    status: {
      latestReadyRevisionName: latest ? "pi-orb-new" : "pi-orb-old",
      latestCreatedRevisionName: "pi-orb-new",
      traffic:
        traffic === "sole"
          ? [{ revisionName: "pi-orb-new", percent: 100, ...(tag ? { tag: "old" } : {}) }]
          : [
              { revisionName: "pi-orb-new", percent: 50 },
              { revisionName: "pi-orb-old", percent: 50 },
            ],
    },
  };
  writeFileSync(join(dir, "service.json"), JSON.stringify(service));
  const value = metrics === "zero" || metrics === "paginated" || metrics === "partial" ? "0" : "1";
  const series = ["pi-orb-old", "pi-orb-new"].flatMap((revision) =>
    ["active", "idle"].map((state) => ({
      metric: { labels: { state } },
      resource: { labels: { revision_name: revision, location: "test-region" } },
      points:
        metrics === "newer-invalid"
          ? [
              { interval: { endTime: "2026-09-06T12:00:40Z" }, value: {} },
              { interval: { endTime: "2026-09-06T12:00:20Z" }, value: { int64Value: "0" } },
            ]
          : [
              {
                interval: {
                  endTime:
                    metrics === "stale"
                      ? "2026-09-06T11:59:59Z"
                      : metrics === "future"
                        ? "2026-09-06T12:01:01Z"
                        : metrics === "bad-time"
                          ? "not-a-time"
                          : "2026-09-06T12:00:30Z",
                },
                value: metrics === "malformed" ? {} : { int64Value: value },
              },
            ],
    })),
  );
  const returnedSeries =
    metrics === "missing"
      ? []
      : metrics === "partial"
        ? series.filter((entry) => entry.metric.labels.state === "active")
        : series;
  writeFileSync(join(dir, "metrics.json"), JSON.stringify({ timeSeries: returnedSeries }));
  writeFileSync(
    join(dir, "metrics-page-1.json"),
    JSON.stringify({ timeSeries: series.slice(0, 2), nextPageToken: "next" }),
  );
  writeFileSync(join(dir, "metrics-page-2.json"), JSON.stringify({ timeSeries: series.slice(2) }));
  writeFileSync(
    join(dir, "gcloud"),
    `#!/bin/bash
echo "gcloud $*" >> "$CALL_LOG"
if [[ "$*" == "run services describe"* ]]; then cat "$FIXTURE_DIR/service.json"
elif [[ "$*" == "run revisions list"* ]]; then printf 'pi-orb-old\\npi-orb-new\\n'
elif [[ "$*" == "auth print-access-token"* ]]; then echo token
fi
if [ "$RESTORE_FAILS" = true ] && [[ "$*" == *"--scaling=auto"* || "$*" == *"--scaling=2"* ]]; then exit 9; fi
`,
  );
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/bash
echo curl >> "$CALL_LOG"
if [ "$METRICS_KIND" = paginated ]; then
  if [[ "$*" == *"pageToken=next"* ]]; then cat "$FIXTURE_DIR/metrics-page-2.json"; else cat "$FIXTURE_DIR/metrics-page-1.json"; fi
else
  cat "$FIXTURE_DIR/metrics.json"
fi
`,
  );
  writeFileSync(
    join(dir, "deploy"),
    `#!/bin/bash
echo "deploy $*" >> "$CALL_LOG"
if [ "\${1:-}" = --iap-only ]; then exit 0; fi
case "$DEPLOY_BEHAVIOR" in
  fail) exit 7 ;;
  signal) kill -TERM "$PPID"; sleep 1 ;;
esac
`,
  );
  writeFileSync(
    join(dir, "date"),
    `#!/bin/bash
if [[ "$*" == *"+%s"* ]]; then echo 1000
elif [ -f "$FIXTURE_DIR/date-used" ]; then echo 2026-09-06T12:01:00Z
else touch "$FIXTURE_DIR/date-used"; echo 2026-09-06T12:00:00Z
fi
`,
  );
  for (const name of ["gcloud", "curl", "deploy", "date"]) chmodSync(join(dir, name), 0o755);
  const result = spawnSync(helper, [join(dir, "state.json"), "--", join(dir, "deploy")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROJECT: "test-project",
      REGION: "test-region",
      GCLOUD: join(dir, "gcloud"),
      CURL: join(dir, "curl"),
      FIXTURE_DIR: dir,
      CALL_LOG: log,
      DEPLOY_BEHAVIOR: deploy,
      RESTORE_FAILS: String(restoreFails),
      METRICS_KIND: metrics,
      DATE: join(dir, "date"),
      QUIESCE_DEADLINE_SECONDS: "0",
      QUIESCE_POLL_SECONDS: "0",
    },
  });
  const calls = readFileSync(log, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { result, calls };
}

test("drains all recorded revisions, deploys, then restores automatic scaling", () => {
  const { result, calls } = fixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /--scaling=0/);
  assert.match(calls, /deploy \n/);
  assert.match(calls, /--scaling=auto/);
  assert.doesNotMatch(calls, /deploy --iap-only/);
});

test("missing metrics fail closed and restore scaling plus IAP", () => {
  const { result, calls } = fixture({ metrics: "missing", mode: "manual" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no fresh zero active\+idle/);
  assert.match(calls, /deploy --iap-only/);
  assert.match(calls, /--scaling=2/);
  assert.doesNotMatch(calls, /deploy \n/);
});

for (const metrics of [
  "stale",
  "malformed",
  "nonzero",
  "partial",
  "newer-invalid",
  "future",
  "bad-time",
]) {
  test(`${metrics} metrics fail closed`, () => {
    const { result, calls } = fixture({ metrics });
    assert.equal(result.status, 1);
    assert.match(calls, /deploy --iap-only/);
    assert.doesNotMatch(calls, /deploy \n/);
  });
}

test("follows Monitoring pagination before proving every revision is zero", () => {
  const { result, calls } = fixture({ metrics: "paginated" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.match(/curl/g)?.length, 2);
});

test("tags, split traffic, and non-latest serving revisions are rejected before disabling", () => {
  for (const options of [{ tag: true }, { traffic: "split" }, { latest: false }]) {
    const { result, calls } = fixture(options);
    assert.equal(result.status, 1);
    assert.doesNotMatch(calls, /--scaling=0/);
  }
});

test("deploy failure preserves its status after IAP and scaling restoration", () => {
  const { result, calls } = fixture({ deploy: "fail" });
  assert.equal(result.status, 7);
  assert.match(calls, /deploy --iap-only/);
  assert.match(calls, /--scaling=auto/);
});

test("termination restores IAP and scaling", () => {
  const { result, calls } = fixture({ deploy: "signal" });
  assert.equal(result.status, 143);
  assert.match(calls, /deploy --iap-only/);
  assert.match(calls, /--scaling=auto/);
});

test("restore failure cannot be reported as success", () => {
  const { result, calls } = fixture({ restoreFails: true });
  assert.equal(result.status, 1);
  assert.match(calls, /--scaling=auto/);
});

test("release parent forwards TERM and waits for child cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-release-child-test-"));
  const log = join(dir, "calls.log");
  const child = join(dir, "child");
  const parent = join(dir, "parent");
  writeFileSync(
    child,
    `#!/bin/bash
trap 'echo cleanup-start >> "$CALL_LOG"; sleep 0.1; echo cleanup-done >> "$CALL_LOG"; exit 143' TERM
echo ready >> "$CALL_LOG"
while :; do sleep 1; done
`,
  );
  writeFileSync(
    parent,
    `#!/bin/bash
set -euo pipefail
source "$CHILD_LIBRARY"
trap 'release_stop_child; exit 143' TERM
release_run_child "$CHILD_COMMAND"
`,
  );
  chmodSync(child, 0o755);
  chmodSync(parent, 0o755);
  const childProcess = spawn(parent, [], {
    env: { ...process.env, CALL_LOG: log, CHILD_LIBRARY: childLibrary, CHILD_COMMAND: child },
  });
  const exited = new Promise((resolve) => childProcess.once("exit", (code) => resolve(code)));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(log) && readFileSync(log, "utf8").includes("ready")) {
        ready = true;
        break;
      }
      await delay(10);
    }
    assert.equal(ready, true, "release child did not publish readiness within 2 seconds");
    childProcess.kill("SIGTERM");
    const status = await exited;
    assert.equal(status, 143);
    assert.match(readFileSync(log, "utf8"), /ready\ncleanup-start\ncleanup-done\n/);
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
