import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scenarios = [
  "parent-first",
  "child-first",
  "queued",
  "cancel-running",
  "cancel-starting",
  "cancel-queued",
  "spawn-failure",
  ...(process.env.USE_RUNTIME === "1"
    ? [
        "resume-cancel",
        "credential-refresh",
        "credential-failure",
        "shutdown-running",
        "inbox-child-only",
      ]
    : []),
];

for (const scenario of scenarios) {
  test(scenario, { timeout: 60_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-liveness-"));
    // Each scenario owns a process: cwd, HOME, Pi registries and extension
    // singletons are process-global. No real credentials or ambient extensions.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      SCENARIO: scenario,
      FIXTURE_ROOT: root,
      USE_RUNTIME: process.env.USE_RUNTIME ?? "0",
    };
    let output = "";
    // Node drops diagnostics issued after a timed-out test; the teardown hook
    // preserves the last observed checkpoint even when the watchdog fires.
    t.after(() => console.log(output));
    const child = spawn(process.execPath, [join(import.meta.dirname, "scenario.mjs")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: t.signal,
      killSignal: "SIGKILL",
    });
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const outcome = await new Promise((resolve) => {
      let failure;
      child.once("error", (error) => {
        failure = String(error);
      });
      // Own the child until stdio/process closure, including watchdog aborts.
      child.once("close", (code, signal) =>
        resolve(failure === undefined ? { code, signal } : { code, signal, error: failure }),
      );
    });
    try {
      // Retain the complete first failure trace in TAP output, not a passing rerun.
      assert.deepEqual(outcome, { code: 0, signal: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
