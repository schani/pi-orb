import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { err, ok } from "neverthrow";
import { EXPECTED_PHASES, HEALTH_PROBE, runStartupSmoke } from "./control-plane-startup-smoke.mjs";

const CID = "a".repeat(64);

function fixture({
  healthy = true,
  failed = null,
  badPhases = false,
  cleanupFails = false,
  stopped = false,
  commandMs = 0,
  operationMs = {},
  createOutput = CID,
  ownership = "match",
  inspectOutput,
  inspectFailures = 0,
  signal,
  onCommand = () => {},
} = {}) {
  let time = 0;
  const calls = [];
  let label;
  const docker = (args, timeout) => {
    calls.push({ args, timeout, at: time });
    const duration = operationMs[args[0]] ?? commandMs;
    time += Math.min(duration, timeout);
    if (args[0] === "create") label = args[args.indexOf("--label") + 1].split("=")[1];
    onCommand(args);
    if (duration > timeout) return err({ code: "docker", operation: args[0], status: "ETIMEDOUT" });
    if (args[0] === failed) return err({ code: "docker", operation: args[0], status: "ETIMEDOUT" });
    if (args[0] === "create") return ok(createOutput);
    if (args[0] === "logs")
      return ok(
        EXPECTED_PHASES.slice(badPhases ? 1 : 0)
          .map((phase, i) =>
            JSON.stringify({ event: "control-plane-startup", phase, elapsed_ms: i }),
          )
          .join("\n"),
      );
    if (args[0] === "inspect") {
      if (inspectFailures-- > 0) return err({ code: "docker", operation: "inspect" });
      if (args.includes("--format")) return ok(stopped ? "false" : "true");
      return ok(
        inspectOutput ??
          JSON.stringify([
            {
              Id: CID,
              Config: {
                Image: ownership === "image-mismatch" ? "other:image" : "candidate:image",
                Labels: {
                  "pi-orb.startup-smoke":
                    ownership === "label-mismatch" ? "other-invocation" : label,
                },
              },
            },
          ]),
      );
    }
    if (args[0] === "exec" && !healthy) return err({ code: "docker", operation: "exec" });
    if (args[0] === "rm" && cleanupFails) return err({ code: "docker", operation: "rm" });
    return ok("");
  };
  return {
    calls,
    ports: {
      docker,
      signal,
      now: () => time,
      sleep: (ms) => {
        time += ms;
      },
    },
  };
}

test("boots the default image command, isolated, checks in-container health and phase order, removes owned CID", async () => {
  const f = fixture();
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isOk(), JSON.stringify(result));
  const create = f.calls[0].args;
  assert.equal(create[0], "create");
  assert.equal(create.at(-1), "candidate:image");
  assert(create.includes("none"));
  assert(create.includes("--pull=never"));
  assert(create.includes("--tmpfs"));
  assert(create.some((arg) => arg.startsWith("pi-orb.startup-smoke=")));
  assert(!create.includes("pi-orb.startup-smoke=unique-fixture"));
  assert(!create.some((arg) => ["--entrypoint", "-p", "--publish", "-v", "--mount"].includes(arg)));
  assert.deepEqual(f.calls.find((c) => c.args[0] === "exec").args, [
    "exec",
    CID,
    "node",
    "--input-type=module",
    "-e",
    HEALTH_PROBE(4000),
  ]);
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("creation within the overall startup budget is not rejected by an unrelated RPC cap", async () => {
  const f = fixture({ operationMs: { create: 6400 } });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isOk(), JSON.stringify(result));
  assert.equal(f.calls[0].timeout, 60000);
  assert.equal(f.calls.find((c) => c.args[0] === "start").at, 6400);
});

test("creation beyond the overall budget fails without starting the container", async () => {
  const f = fixture({ operationMs: { create: 60001 } });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.equal(result.error.code, "deadline");
  assert(!f.calls.some((c) => c.args[0] === "start"));
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("health fetch cannot outlive the remaining startup budget", async () => {
  const f = fixture({ operationMs: { create: 58000 } });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isOk(), JSON.stringify(result));
  const probe = f.calls.find((c) => c.args[0] === "exec");
  assert.equal(probe.timeout, 2000);
  assert.match(probe.args.at(-1), /AbortSignal.timeout\(2000\)/);
});

test("fixed deadline bounds repeated not-ready probes and still cleans up", async () => {
  const f = fixture({ healthy: false });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.equal(result.error.code, "deadline");
  assert(f.calls.length < 200);
  for (const call of f.calls) {
    const budget = ["logs", "rm"].includes(call.args[0]) ? 5000 : 60000 - call.at;
    assert(call.timeout > 0 && call.timeout <= budget);
  }
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

for (const failed of ["start", "logs"]) {
  test(`cleans up after ${failed} failure`, async () => {
    const f = fixture({ failed });
    const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
    assert(result.isErr());
    assert.equal(f.calls.at(-1).args[0], "rm");
    assert.equal(f.calls.at(-1).args.at(-1), CID);
  });
}

test("rejects incomplete phase evidence and cleanup failure", async () => {
  for (const options of [{ badPhases: true }, { cleanupFails: true }]) {
    const f = fixture(options);
    assert((await runStartupSmoke(f.ports, "candidate:image", "unique-fixture")).isErr());
  }
});

test("image preloads bootstrap without changing main or the explicit migration command", () => {
  const dockerfile = readFileSync(
    new URL("../apps/control-plane/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    dockerfile,
    /CMD \["node", "--import", "\.\/apps\/control-plane\/src\/startup-bootstrap\.ts", "apps\/control-plane\/src\/main\.ts"\]/,
  );
  const release = readFileSync(new URL("../infra/release.sh", import.meta.url), "utf8");
  assert(!release.includes("startup-bootstrap"));
  assert.match(release, /--command=node --args=apps\/control-plane\/src\/migrate\.ts/);
});

test("stopped container fails immediately and preserves logs before cleanup", async () => {
  const f = fixture({ healthy: false, stopped: true });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.equal(result.error.code, "container_stopped");
  assert(result.error.logs.includes("bootstrap.enter"));
  assert.equal(f.calls.filter((call) => call.args[0] === "exec").length, 1);
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("command budgets shrink at the absolute deadline; evidence/cleanup remain bounded", async () => {
  const f = fixture({ healthy: false, commandMs: 3400 });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.equal(result.error.code, "deadline");
  const work = f.calls.filter((call) => !["logs", "rm"].includes(call.args[0]));
  assert(work.some((call) => call.timeout < 5000));
  assert.equal(f.calls.at(-2).timeout, 5000);
  assert.equal(f.calls.at(-1).timeout, 5000);
});

for (const ownership of ["label-mismatch", "image-mismatch"]) {
  test(`create collision never logs or removes unowned container: ${ownership}`, async () => {
    const f = fixture({ failed: "create", ownership });
    const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
    assert(result.isErr());
    assert.deepEqual(
      f.calls.map((c) => c.args[0]),
      ["create", "inspect"],
    );
    assert.equal(f.calls.at(-1).args.at(-1), "unique-fixture");
  });
}

test("uncertain create adopts only verified invocation label plus image and cleans by CID", async () => {
  const f = fixture({ failed: "create" });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect", "logs", "rm"],
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("invalid create CID is not used as a container target", async () => {
  const f = fixture({ createOutput: "not-a-cid", ownership: "label-mismatch" });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert(result.isErr());
  assert.equal(result.error.code, "invalid_container_id");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect"],
  );
});

test("cleanup failure has an explicit result", async () => {
  const f = fixture({ cleanupFails: true });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "cleanup_failed");
});

test("cancellation aborts work but still captures evidence and cleans owned CID", async () => {
  const controller = new AbortController();
  const f = fixture({
    signal: controller.signal,
    onCommand: (args) => {
      if (args[0] === "exec") controller.abort();
    },
  });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "cancelled");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "start", "exec", "logs", "rm"],
  );
});

test("already cancelled invocation does not create a container", async () => {
  const f = fixture({ signal: AbortSignal.abort() });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "cancelled");
  assert.equal(f.calls.length, 0);
});

test("health fetch self-expires before the Docker exec budget", () => {
  assert.match(HEALTH_PROBE(4000), /signal: AbortSignal.timeout\(4000\)/);
});

for (const signal of ["SIGTERM", "SIGINT", "command-timeout"]) {
  test(`actual CLI handles ${signal}, kills an uncooperative Docker child and cleans by CID`, {
    timeout: 10000,
  }, async () => {
    const dir = mkdtempSync(
      join(process.env.STARTUP_SMOKE_EVIDENCE_DIR ?? tmpdir(), "smoke-signal-"),
    );
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      join(dir, "docker"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "create") console.log("${CID}");
if (args[0] === "inspect") console.log("false");
if (args[0] === "exec") {
  process.on("SIGTERM", () => {});
  ${signal === "command-timeout" ? "" : `process.kill(process.ppid, "${signal}");`}
  setInterval(() => {}, 1000);
}
`,
      { mode: 0o755 },
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["scripts/control-plane-startup-smoke.mjs", "candidate:image"],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        timeout: 8000,
        killSignal: "SIGKILL",
      },
    ).then(
      (value) => value,
      (error) => error,
    );
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.match(
      result.stdout,
      signal === "command-timeout" ? /"code":"container_stopped"/ : /"code":"cancelled"/,
    );
    assert.deepEqual(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)[0]),
      signal === "command-timeout"
        ? ["create", "start", "exec", "inspect", "logs", "rm"]
        : ["create", "start", "exec", "logs", "rm"],
    );
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").trim().split("\n").at(-1)), [
      "rm",
      "-f",
      CID,
    ]);
  });
}

for (const inspectOutput of ["invalid JSON", "null", JSON.stringify([{ Id: "invalid-cid" }])]) {
  test(`uncertain create never logs/removes malformed ownership evidence: ${inspectOutput}`, async () => {
    const f = fixture({ failed: "create", inspectOutput });
    const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
    assert.equal(result.error.recovery, "ownership_not_verified");
    assert.deepEqual(
      f.calls.map((c) => c.args[0]),
      ["create", "inspect"],
    );
  });
}

test("invalid create output can recover an owned CID for evidence/cleanup, not startup", async () => {
  const f = fixture({ createOutput: "invalid-cid" });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "invalid_container_id");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect", "logs", "rm"],
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("cancelled uncertain create only verifies ownership, captures evidence, and cleans", async () => {
  const controller = new AbortController();
  const f = fixture({
    signal: controller.signal,
    onCommand: (args) => {
      if (args[0] === "create") controller.abort();
    },
  });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "cancelled");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect", "logs", "rm"],
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("create completing after the first recovery inspect is adopted within the cleanup budget", async () => {
  const f = fixture({ failed: "create", inspectFailures: 1 });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "docker");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect", "inspect", "logs", "rm"],
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("unresolved create recovery is bounded and reports ownership for external cleanup", async () => {
  const f = fixture({ failed: "create", inspectFailures: Infinity });
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.recovery, "ownership_inspect_failed");
  assert.equal(result.error.name, "unique-fixture");
  assert.equal(
    result.error.ownership,
    f.calls[0].args[f.calls[0].args.indexOf("--label") + 1].split("=")[1],
  );
  assert(f.calls.length < 60);
  assert(f.calls.every((c) => ["create", "inspect"].includes(c.args[0])));
  assert.equal(f.calls[0].timeout, 60000);
  assert(f.calls.slice(1).every((c) => c.timeout <= 5000));
});

test("autonomous startup timer aborts a pending command even when the injected clock is parked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const runDocker = f.ports.docker;
  f.ports.docker = (args, timeout, signal) => {
    const result = runDocker(args, timeout);
    return args[0] === "create"
      ? new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(err({ code: "docker" })), { once: true });
        })
      : result;
  };
  const pending = runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  t.mock.timers.tick(60_000);
  const result = await pending;
  assert.equal(result.error.code, "deadline");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "inspect", "logs", "rm"],
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", CID]);
});

test("cancellation while sleeping admits no further startup command", async () => {
  const controller = new AbortController();
  const f = fixture({ healthy: false, signal: controller.signal });
  f.ports.sleep = async () => controller.abort();
  const result = await runStartupSmoke(f.ports, "candidate:image", "unique-fixture");
  assert.equal(result.error.code, "cancelled");
  assert.deepEqual(
    f.calls.map((c) => c.args[0]),
    ["create", "start", "exec", "inspect", "logs", "rm"],
  );
});
