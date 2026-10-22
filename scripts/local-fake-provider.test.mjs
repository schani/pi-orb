import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { err, ok } from "neverthrow";
import {
  canonicalOrigin,
  classifyNpmFailure,
  FLING_INTEGRITY,
  inspectService,
  installNpm,
  launch,
  ownershipPorts,
  PIN,
  runTool,
  supervise,
  validatePins,
} from "./local-fake-provider.mjs";

function serviceFiles(overrides = {}) {
  return {
    readdir: async (path) => (path === "/proc" ? ["103"] : ["7", "8"]),
    readFile: async (path) => {
      if (path === "/log") return '[worker] PID 103 (ppid 101)\n[migrate] Completed "001_init"';
      if (path.endsWith("/stat"))
        return `103 (node) ${["S", "101", "101", ...Array(16).fill("0"), "900"].join(" ")}`;
      if (path.endsWith("tcp6"))
        return "header\n0: 00000000000000000000000000000000:0C8A 0000:0000 0A 0 0 0 0 0 700\n1: 00000000000000000000000000000000:1435 0000:0000 0A 0 0 0 0 0 800";
      return "header";
    },
    readlink: async (path) => `socket:[${path.endsWith("/7") ? 700 : 800}]`,
    stat: async () => ({ isFile: () => true }),
    ...overrides,
  };
}
test("socket ownership requires group membership and matching worker PID", async () => {
  const owned = await inspectService(101, "/log", "/db", serviceFiles());
  assert.equal(owned.value.identity, true);
  assert.equal(owned.value.migrations, true);
  const foreign = await inspectService(999, "/log", "/db", serviceFiles());
  assert.equal(foreign.value.identity, false);
});
test("only disappearing proc entries are recoverable, not permission or I/O failure", async () => {
  for (const code of ["ENOENT", "EACCES", "EIO"]) {
    const io = serviceFiles({
      readdir: async (path) => {
        if (path === "/proc") return ["103"];
        throw Object.assign(new Error("private details"), { code });
      },
    });
    const result = await inspectService(101, "/log", "/db", io);
    if (code === "ENOENT") assert.equal(result.value.identity, false);
    else assert.deepEqual(result.error, { type: "proc_read" });
  }
});
test("DB/log failure is scoped and cannot masquerade as readiness", async () => {
  const log = await inspectService(
    101,
    "/log",
    "/db",
    serviceFiles({
      readFile: async () => {
        throw new Error("private log");
      },
    }),
  );
  assert.deepEqual(log.error, { type: "service_log" });
  const db = await inspectService(
    101,
    "/log",
    "/db",
    serviceFiles({
      stat: async () => {
        throw Object.assign(new Error("private DB"), { code: "EACCES" });
      },
    }),
  );
  assert.deepEqual(db.error, { type: "db_stat" });
});
function fixture(overrides = {}) {
  let time = 0;
  const events = [];
  const service = { pid: 101, exit: undefined };
  const command = { pid: 202, exit: undefined };
  let alive = true;
  const p = {
    now: () => time,
    wait: async () => {
      time += 100;
      command.exit ??= { code: 7 };
    },
    start: async (kind, env) => {
      events.push([kind, env]);
      return ok(kind === "service" ? service : command);
    },
    inspect: async () =>
      ok({
        migrations: true,
        identity: true,
        address: "::",
        workerPid: 103,
        workerBirth: "900",
        vitePid: 104,
        viteBirth: "901",
        restartCount: 0,
        failed: false,
      }),
    health: async () => ok(true),
    alive: async () => ok(alive),
    signal: async (pid, signal) => {
      events.push([pid, signal]);
      alive = false;
      service.exit ??= { code: 0 };
      command.exit ??= { code: 0 };
      return ok(undefined);
    },
    interrupted: () => undefined,
    ...overrides,
  };
  return { p, events, service, command, time: () => time };
}
const settings = {
  origin: "http://127.0.0.1:3210",
  env: { SAFE: "yes" },
  startupMs: 300,
  stopMs: 200,
};

test("pin verification rejects HEAD, lock and installed version drift", () => {
  const lock = {
    packages: {
      "node_modules/flingit": {
        version: "0.0.70",
        integrity: FLING_INTEGRITY,
        resolved: "https://registry.npmjs.org/flingit/-/flingit-0.0.70.tgz",
      },
    },
  };
  assert.equal(validatePins(PIN, lock, "0.0.70").isOk(), true);
  for (const args of [
    ["main", lock, "0.0.70"],
    [PIN, {}, "0.0.70"],
    [PIN, null, "0.0.70"],
    [PIN, lock, "0.0.71"],
  ])
    assert.equal(validatePins(...args).error.type, "pin_mismatch");
});
test("canonical Docker origin uses inspected gateway, never fallback", () => {
  assert.equal(canonicalOrigin("process").value, "http://127.0.0.1:3210");
  assert.equal(canonicalOrigin("docker", "172.19.0.1").value, "http://172.19.0.1:3210");
  assert.equal(canonicalOrigin("docker").isErr(), true);
  assert.equal(canonicalOrigin("typo").isErr(), true);
});
test("starts command only after owned migration and IPv4 readiness; preserves exit and environment", async () => {
  const f = fixture();
  const result = await supervise(f.p, settings);
  assert.equal(result.code, 7);
  assert.equal(f.events[1][0], "command");
  assert.equal(f.events[1][1].PI_ORB_FAKE_OPENAI, settings.origin);
  assert.equal(f.events[1][1].SAFE, "yes");
  assert.deepEqual(f.events.at(-1), [101, "SIGTERM"]);
});
for (const field of ["identity", "migrations"])
  test(`health cannot replace ${field} proof; startup is bounded`, async () => {
    const f = fixture({
      inspect: async () => ok({ identity: true, migrations: true, [field]: false }),
    });
    const result = await supervise(f.p, settings);
    assert.equal(result.error.type, "startup_timeout");
    assert.equal(f.time(), 300);
    assert.equal(
      f.events.some(([kind]) => kind === "command"),
      false,
    );
  });
test("health transport failure is not healthy", async () => {
  const f = fixture({ health: async () => err({ type: "health_transport" }) });
  assert.equal((await supervise(f.p, settings)).error.type, "startup_timeout");
});
test("worker/Vite restart failure is terminal despite living CLI", async () => {
  const f = fixture({ inspect: async () => ok({ failed: true }) });
  assert.equal((await supervise(f.p, settings)).error.type, "service_failed");
  assert.equal(
    f.events.some(([kind]) => kind === "command"),
    false,
  );
});
test("CLI exit before readiness is terminal", async () => {
  const f = fixture();
  f.service.exit = { code: 4 };
  assert.equal((await supervise(f.p, settings)).error.type, "service_exited");
});
test("service loss terminates command rather than claiming its success", async () => {
  const f = fixture({
    wait: async () => {
      f.service.exit = { code: 4 };
    },
  });
  const result = await supervise(f.p, settings);
  assert.equal(result.error.type, "service_exited");
  assert.ok(f.events.some(([pid, signal]) => pid === 202 && signal === "SIGTERM"));
});
test("TERM timeout escalates only owned groups; cleanup failure preserves command failure", async () => {
  const f = fixture({
    signal: async (pid, signal) => {
      f.events.push([pid, signal]);
      return ok(undefined);
    },
    alive: async () => ok(true),
  });
  const result = await supervise(f.p, settings);
  assert.equal(result.code, 7);
  assert.equal(result.cleanupError.type, "cleanup_timeout");
  assert.ok(f.events.some(([pid, signal]) => pid === 101 && signal === "SIGKILL"));
  assert.ok(
    f.events.filter(([pid]) => typeof pid === "number").every(([pid]) => [101, 202].includes(pid)),
  );
});
test("signal is forwarded to owned groups and yields interruption status", async () => {
  const f = fixture({ interrupted: () => "SIGINT" });
  const result = await supervise(f.p, settings);
  assert.equal(result.code, 130);
  assert.ok(f.events.some(([pid, signal]) => pid === 101 && signal === "SIGINT"));
});
test("sanitized phases exclude command environment and secrets", async () => {
  const f = fixture();
  const result = await supervise(f.p, { ...settings, env: { TOKEN: "private-token" } });
  assert.equal(JSON.stringify(result.phases).includes("private-token"), false);
  assert.equal(JSON.stringify(result.phases).includes("TOKEN"), false);
});
test("service dying during health never starts command", async () => {
  const f = fixture({
    health: async () => {
      f.service.exit = { code: 3 };
      return ok(true);
    },
  });
  assert.equal((await supervise(f.p, settings)).error.type, "service_exited");
  assert.equal(
    f.events.some(([kind]) => kind === "command"),
    false,
  );
});
test("command launch failure cleans only the service", async () => {
  const f = fixture();
  const start = f.p.start;
  f.p.start = (kind, env) =>
    kind === "command" ? err({ type: "spawn_failed" }) : start(kind, env);
  const result = await supervise(f.p, settings);
  assert.equal(result.error.type, "spawn_failed");
  assert.deepEqual(f.events.at(-1), [101, "SIGTERM"]);
});
test("signal during command forwards to both groups", async () => {
  let signal;
  const f = fixture({ interrupted: () => signal });
  const wait = f.p.wait;
  f.p.wait = async () => {
    signal = "SIGTERM";
    await wait();
  };
  const result = await supervise(f.p, settings);
  assert.equal(result.code, 143);
  assert.ok(f.events.some(([pid, sent]) => pid === 101 && sent === signal));
  assert.ok(f.events.some(([pid, sent]) => pid === 202 && sent === signal));
});
test("cleanup failure cannot convert success into a pass", async () => {
  const f = fixture({ signal: async () => err({ type: "group_signal" }) });
  f.command.exit = { code: 0 };
  const result = await supervise(f.p, settings);
  assert.equal(result.code, 1);
  assert.equal(result.cleanupError.type, "group_signal");
});
test("adapter failure retains narrow type and does not launch tests", async () => {
  const f = fixture({ inspect: async () => err({ type: "proc_read" }) });
  assert.equal((await supervise(f.p, settings)).error.type, "proc_read");
  assert.equal(
    f.events.some(([kind]) => kind === "command"),
    false,
  );
});

for (const field of ["workerPid", "workerBirth", "vitePid", "viteBirth", "restartCount"])
  test(`ready identity rejects replacement: ${field}, even with successful command`, async () => {
    const f = fixture();
    const inspect = f.p.inspect;
    let calls = 0;
    f.p.inspect = async () => {
      const result = await inspect();
      if (++calls > 1) result.value[field] = field.endsWith("Birth") ? "999" : 999;
      return result;
    };
    f.command.exit = { code: 0 };
    const result = await supervise(f.p, settings);
    assert.equal(result.code, 1);
    assert.equal(result.error.type, "service_failed");
    assert.deepEqual(result.phases.find((p) => p.phase === "service_failed").changed, [field]);
  });
test("startup restart evidence is allowed until ready; later edge is terminal", async () => {
  const f = fixture();
  const inspect = f.p.inspect;
  let calls = 0;
  f.p.inspect = async () => {
    const result = await inspect();
    result.value.restartCount = ++calls < 3 ? 2 : 3;
    return result;
  };
  const result = await supervise(f.p, settings);
  assert.equal(result.error?.type, "service_failed");
  assert.ok(result.phases.some((p) => p.phase === "ready"));
});
for (const message of ["Files changed, restarting...", "Secrets changed, restarting..."])
  test(`inspection records durable restart edge: ${message}`, async () => {
    const io = serviceFiles();
    const read = io.readFile;
    io.readFile = async (path) =>
      (await read(path)) + (path === "/log" ? `\n[worker] ${message}` : "");
    const result = await inspectService(101, "/log", "/db", io);
    assert.equal(result.value.restartCount, 1);
    assert.equal(result.value.workerBirth, "900");
    assert.equal(result.value.viteBirth, "900");
    assert.equal(result.value.failed, false);
  });

test("worker replacement during initial startup is allowed before ready", async () => {
  const f = fixture();
  const inspect = f.p.inspect;
  let calls = 0;
  f.p.inspect = async () => {
    const result = await inspect();
    if (++calls === 1) result.value.identity = false;
    else result.value.workerBirth = "999";
    return result;
  };
  assert.equal((await supervise(f.p, settings)).code, 7);
});

// Real process ownership reads Linux /proc.
const linux = process.platform === "linux";
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
async function checkpoint(path) {
  for (let n = 0; n < 500; n++) {
    const result = await fs.readFile(path, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (result) return result;
    await pause();
  }
  assert.fail(`fixture checkpoint missing: ${path}`);
}
async function exited(child) {
  for (let n = 0; n < 500; n++) {
    if (child.exit) return;
    await pause();
  }
  assert.fail(`fixture did not exit: ${child.pid}`);
}
async function ownedFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "local-fake-fixture-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      await ownershipPorts.signal(child.pid, "SIGKILL");
      await exited(child);
      for (let n = 0; n < 500; n++) {
        if (!(await ownershipPorts.alive(child.pid)).value) break;
        await pause();
      }
      assert.equal((await ownershipPorts.alive(child.pid)).value, false);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = async (code) => {
    const output = await fs.open(join(root, `output-${children.length}.log`), "w", 0o600);
    const result = await launch(process.execPath, ["--input-type=module", "-e", code], {}, output);
    await output.close();
    assert.equal(result.isOk(), true);
    children.push(result.value);
    return result.value;
  };
  return { root, start };
}
test("real executable failure and missing executable remain typed nonzero", async (t) => {
  if (!linux) return t.skip("needs Linux /proc");
  const { root } = await ownedFixture(t);
  const result = await runTool(
    process.execPath,
    ["-e", "process.exit(23)"],
    {},
    root,
    () => undefined,
  );
  assert.deepEqual(result.error, { type: "tool_failed", code: 23 });
  const missing = await runTool(join(root, "absent"), [], {}, root, () => undefined);
  assert.deepEqual(missing.error, { type: "spawn_failed" });
});
test("real leader exit reaps live descendant and preserves failing status; foreign group survives", async (t) => {
  if (!linux) return t.skip("needs Linux /proc");
  const f = await ownedFixture(t);
  const foreign = await f.start("setInterval(() => {}, 1000)");
  const checkpointPath = join(f.root, "descendant");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(checkpointPath)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const leader = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(checkpointPath)}))process.exit(29)},10);`;
  const result = await runTool(process.execPath, ["-e", leader], {}, f.root, () => undefined);
  const pid = Number(await checkpoint(checkpointPath));
  assert.deepEqual(result.error, { type: "tool_failed", code: 29 });
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "));
  assert.equal((await ownershipPorts.alive(foreign.pid)).value, true);
});
for (const signal of ["SIGINT", "SIGTERM"])
  test(`actual wrapper ${signal} cancels preparation and cleans owned descendant`, async (t) => {
    if (!linux) return t.skip("needs Linux /proc");
    const f = await ownedFixture(t);
    const bin = join(f.root, "bin");
    await fs.mkdir(bin);
    const marker = join(f.root, "ready");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`;
    await fs.writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); setInterval(()=>{},1000);\n`.replaceAll(
        "\\n",
        "\n",
      ),
      { mode: 0o700 },
    );
    const evidence = join(f.root, "evidence");
    const wrapper = fileURLToPath(new URL("./local-fake-provider.mjs", import.meta.url));
    const handle = await f.start(
      `import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(wrapper)},'--',${JSON.stringify(process.execPath)},'-e','process.exit(0)'],{env:{...process.env,PATH:${JSON.stringify(bin + ":" + process.env.PATH)},PI_ORB_E2E_BACKEND:'process',PI_ORB_LOCAL_FAKE_EVIDENCE:${JSON.stringify(evidence)}},stdio:'inherit'}); process.on('${signal}',()=>child.kill('${signal}')); child.on('exit',(code)=>process.exit(code));`,
    );
    const pid = Number(await checkpoint(marker));
    assert.equal((await ownershipPorts.signal(handle.pid, signal)).isOk(), true);
    await exited(handle);
    assert.equal(handle.exit.code, signal === "SIGINT" ? 130 : 143);
    const manifest = JSON.parse(await checkpoint(join(evidence, "manifest.json")));
    assert.equal(manifest.code, handle.exit.code);
    const phases = JSON.parse(await checkpoint(join(evidence, "phases.json")));
    assert.equal(phases.at(-1).error, "interrupted");
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "));
  });

for (const status of [0, 37])
  test(`actual supervised command exit ${status} cleans both groups`, async (t) => {
    if (!linux) return t.skip("needs Linux /proc");
    const f = await ownedFixture(t);
    const service = await f.start("setInterval(()=>{},1000)");
    const command = await f.start(`process.exit(${status})`);
    const ports = fixture().p;
    const result = await supervise(
      {
        ...ports,
        ...ownershipPorts,
        start: async (kind) => ok(kind === "service" ? service : command),
      },
      { ...settings, startupMs: 5000, stopMs: 1000 },
    );
    assert.equal(result.code, status);
    assert.equal(result.phases.filter((phase) => phase.phase === "cleanup" && phase.ok).length, 2);
    for (const child of [service, command])
      assert.equal((await ownershipPorts.alive(child.pid)).value, false);
  });
test("actual TERM-ignoring owned group escalates at injected deadline; unrelated group survives", async (t) => {
  if (!linux) return t.skip("needs Linux /proc");
  const f = await ownedFixture(t);
  const marker = join(f.root, "ignoring");
  const service = await f.start(
    `import * as fs from 'node:fs'; process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000)`,
  );
  await checkpoint(marker);
  const foreign = await f.start("setInterval(()=>{},1000)");
  const command = await f.start("process.exit(0)");
  await exited(command);
  let time = 0;
  let termPending = false;
  const base = fixture().p;
  const result = await supervise(
    {
      ...base,
      ...ownershipPorts,
      now: () => time,
      wait: async () => {
        await pause();
        time += termPending ? 1000 : 1;
        termPending = false;
      },
      start: async (kind) => ok(kind === "service" ? service : command),
      signal: async (pid, signal) => {
        termPending = pid === service.pid && signal === "SIGTERM";
        return ownershipPorts.signal(pid, signal);
      },
    },
    { ...settings, startupMs: 5000, stopMs: 1000 },
  );
  assert.equal(result.code, 0);
  assert.equal(
    result.phases.find((phase) => phase.phase === "cleanup" && phase.pid === service.pid).escalated,
    true,
  );
  assert.equal(service.exit.signal, "SIGKILL");
  assert.equal((await ownershipPorts.alive(service.pid)).value, false);
  assert.equal((await ownershipPorts.alive(foreign.pid)).value, true);
});

for (const signal of ["SIGINT", "SIGTERM"])
  test(`actual cancelled command exiting zero cannot erase ${signal}`, async (t) => {
    if (!linux) return t.skip("needs Linux /proc");
    const f = await ownedFixture(t);
    const service = await f.start("setInterval(()=>{},1000)");
    const marker = join(f.root, "command-ready");
    const command = await f.start(
      `import * as fs from 'node:fs'; process.on('${signal}',()=>process.exit(0)); fs.writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000)`,
    );
    await checkpoint(marker);
    let interrupt;
    const result = await supervise(
      {
        ...fixture().p,
        ...ownershipPorts,
        start: async (kind) => ok(kind === "service" ? service : command),
        interrupted: () => interrupt,
        wait: async () => {
          interrupt = signal;
          await pause();
        },
      },
      { ...settings, startupMs: 5000, stopMs: 1000 },
    );
    assert.equal(command.exit.code, 0);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    for (const child of [service, command])
      assert.equal((await ownershipPorts.alive(child.pid)).value, false);
  });

const fetchSummary =
  "request to https://token:secret@example.invalid/pkg?key=private failed, reason: socket hang up";
function npmFailure(code = "ECONNRESET", stderr, extra = {}) {
  const failure = { code, summary: fetchSummary, detail: "", ...extra };
  return classifyNpmFailure(
    JSON.stringify({ error: failure }),
    stderr ??
      `npm error code ${code}\nnpm error errno -104\nnpm error network ${typeof failure.summary === "string" ? failure.summary : ""}\n`,
  );
}
test("npm failure retains only finite classification/code/errno; exit 152 proves nothing", () => {
  assert.deepEqual(npmFailure(), {
    classification: "transient_network",
    npmCode: "ECONNRESET",
    errno: -104,
    clipped: false,
  });
  assert.equal(classifyNpmFailure("", "").classification, "unknown");
  for (const code of [
    "E401",
    "E403",
    "CERT_HAS_EXPIRED",
    "EINTEGRITY",
    "EUSAGE",
    "ELIFECYCLE",
    "PRIVATE_TOKEN",
  ]) {
    const result = npmFailure(code);
    assert.notEqual(result.classification, "transient_network");
    assert.equal(JSON.stringify(result).includes("PRIVATE_TOKEN"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.equal(npmFailure("ECONNRESET", "npm error errno private-token").errno, null);
});
test("npm final JSON is authoritative; network-looking lifecycle stderr never retries", () => {
  for (const stderr of [
    "npm error code ECONNRESET\nnpm error command failed\nnpm error command sh -c private-token",
    "npm ERR! code ECONNRESET\nnpm ERR! command sh -c private-token",
  ])
    assert.equal(npmFailure("ECONNRESET", stderr).classification, "lifecycle");
  assert.equal(npmFailure(1, "npm error code ECONNRESET").classification, "unknown");
  assert.equal(
    npmFailure("ECONNRESET", "", {
      summary: "command failed",
      detail: "request to private URL ECONNRESET",
    }).classification,
    "lifecycle",
  );
  assert.equal(
    npmFailure("ECONNRESET", "", { summary: "some arbitrary network-looking payload" })
      .classification,
    "unknown",
  );
  assert.equal(
    classifyNpmFailure('prefix\n{"error":{"code":"ECONNRESET"}}', "").classification,
    "unknown",
  );
});
test("oversized or clipped npm diagnostics fail closed, never expose text", () => {
  for (const [stdout, stderr] of [
    ["x".repeat(65537), ""],
    ["", "x".repeat(65537)],
    [JSON.stringify({ error: { code: "ECONNRESET" } }), ""],
  ])
    assert.notEqual(classifyNpmFailure(stdout, stderr).classification, "transient_network");
  assert.deepEqual(classifyNpmFailure("", "", true), {
    classification: "unknown",
    npmCode: null,
    errno: null,
    clipped: true,
  });
});
function installFixture(results, durations = []) {
  let time = 0;
  const calls = [],
    phases = [];
  let interrupted;
  return {
    calls,
    phases,
    interrupt: (signal) => {
      interrupted = signal;
    },
    p: {
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      interrupted: () => interrupted,
      run: async (timeoutMs) => {
        calls.push(timeoutMs);
        time += durations[calls.length - 1] ?? 100;
        return results[Math.min(calls.length - 1, results.length - 1)];
      },
      phase: (phase) => phases.push(phase),
    },
  };
}
const networkFailure = () => err({ type: "tool_failed", code: 152, npm: npmFailure() });
test("only confirmed transient install errors retry, at most three attempts, within one budget", async () => {
  const f = installFixture([networkFailure(), networkFailure(), ok("")], [1000, 2000, 4000]);
  assert.equal((await installNpm(f.p)).isOk(), true);
  assert.deepEqual(f.calls, [300000, 298000, 294000]);
  assert.deepEqual(
    f.phases.map((p) => [p.attempt, p.elapsedMs, p.decision]),
    [
      [1, 2000, "retry"],
      [2, 6000, "retry"],
      [3, 10000, "success"],
    ],
  );
  const exhausted = installFixture([networkFailure()]);
  assert.equal((await installNpm(exhausted.p)).error.code, 152);
  assert.equal(exhausted.calls.length, 3);
  assert.equal(exhausted.phases.at(-1).decision, "attempts_exhausted");
});
test("install clips remaining budget and never retries timeout, spawn, cleanup, unknown or terminal npm errors", async () => {
  const budget = installFixture([networkFailure()], [300000]);
  assert.equal((await installNpm(budget.p)).isErr(), true);
  assert.deepEqual(budget.calls, [300000]);
  assert.equal(budget.phases.at(-1).decision, "budget_exhausted");
  for (const error of [
    { type: "tool_failed", code: 152 },
    ...[
      "tool_timeout",
      "spawn_failed",
      "cleanup_timeout",
      "group_signal",
      "interrupted",
      "tool_log",
    ].map((type) => ({ type })),
    ...["E401", "EINTEGRITY", "CERT_HAS_EXPIRED", "EUSAGE", "ELIFECYCLE"].map((code) => ({
      type: "tool_failed",
      code: 1,
      npm: npmFailure(code),
    })),
  ]) {
    const f = installFixture([err(error)]);
    assert.equal((await installNpm(f.p)).isErr(), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.phases.at(-1).decision, "terminal");
  }
});
test("interruption before or between attempts prevents another install, even after zero exit", async () => {
  const before = installFixture([ok("")]);
  before.interrupt("SIGINT");
  assert.equal((await installNpm(before.p)).error.type, "interrupted");
  assert.equal(before.calls.length, 0);
  for (const result of [networkFailure(), ok("")]) {
    const f = installFixture([result]);
    const run = f.p.run;
    f.p.run = async (remaining) => {
      const outcome = await run(remaining);
      f.interrupt("SIGTERM");
      return outcome;
    };
    assert.equal((await installNpm(f.p)).error.type, "interrupted");
    assert.equal(f.calls.length, 1);
    assert.equal(f.phases.at(-1).decision, "interrupted");
  }
});

test("dependency output cannot spoof npm final JSON or override terminal diagnostics", () => {
  const forged = JSON.stringify({
    error: {
      code: "ECONNRESET",
      summary: "request to https://private.invalid failed, reason: reset",
      detail: "",
    },
  });
  const stderr = "npm error code ECONNRESET\nnpm error errno -104";
  for (const output of [
    `${forged}\n${JSON.stringify({ error: { code: 1, summary: "command failed", detail: "" } })}`,
    `${forged}\n${JSON.stringify({ added: 1 })}`,
    `> install\n${forged}`,
  ])
    assert.notEqual(classifyNpmFailure(output, stderr).classification, "transient_network");
  for (const code of ["E401", "CERT_HAS_EXPIRED", "EINTEGRITY", "EUSAGE", "ELIFECYCLE"])
    assert.notEqual(
      npmFailure(
        "ECONNRESET",
        `${stderr}\nnpm error network ${fetchSummary}\nnpm error ${code} private-token`,
      ).classification,
      "transient_network",
    );
});
test("late success cannot overrun the fixed install deadline", async () => {
  const f = installFixture([ok("")], [300001]);
  assert.equal((await installNpm(f.p)).error.type, "tool_timeout");
  assert.equal(f.phases.at(-1).decision, "budget_exhausted");
});
test("tool wait clips to remaining deadline; cleanup failure after success remains terminal", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "local-fake-clock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let time = 0;
  const waits = [],
    signals = [];
  const result = await runTool("stub", [], {}, root, () => undefined, {
    timeoutMs: 125,
    ports: {
      now: () => time,
      wait: async (ms) => {
        waits.push(ms);
        time += ms;
      },
      launch: async () => ok({ pid: 101 }),
      cleanup: async (_ports, _child, signal) => {
        signals.push(signal);
        return ok(undefined);
      },
    },
  });
  assert.equal(result.error.type, "tool_timeout");
  assert.deepEqual(waits, [100, 25]);
  assert.deepEqual(signals, ["SIGTERM"]);
  const cleanup = await runTool("stub", [], {}, root, () => undefined, {
    ports: {
      launch: async () => ok({ pid: 101, exit: { code: 0 } }),
      cleanup: async () => err({ type: "cleanup_timeout" }),
    },
  });
  assert.equal(cleanup.error.type, "cleanup_timeout");
});

for (const mode of ["network", "spoof", "unknown", "clipped"])
  test(`actual wrapper persists sanitized npm diagnosis and decision: ${mode}`, async (t) => {
    if (!linux) return t.skip("needs Linux /proc");
    const f = await ownedFixture(t);
    const bin = join(f.root, "bin");
    await fs.mkdir(bin);
    const lock = {
      packages: {
        "node_modules/flingit": {
          version: "0.0.70",
          integrity: FLING_INTEGRITY,
          resolved: "https://registry.npmjs.org/flingit/-/flingit-0.0.70.tgz",
        },
      },
    };
    await fs.writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2); if(a[0]==='init'){fs.mkdirSync(a.at(-1));fs.writeFileSync(a.at(-1)+'/package-lock.json',${JSON.stringify(JSON.stringify(lock))});} if(a[0]==='rev-parse') console.log('${PIN}');\n`,
      { mode: 0o700 },
    );
    const attempts = join(f.root, "attempts");
    const fetchError = {
      error: {
        code: "ECONNRESET",
        summary:
          "request to https://user:private-token@example.invalid/pkg?key=secret failed, reason: reset",
        detail: "",
      },
    };
    const output =
      mode === "unknown"
        ? ""
        : mode === "clipped"
          ? "x".repeat(65537)
          : JSON.stringify(fetchError) +
            (mode === "spoof"
              ? `\n${JSON.stringify({ error: { code: 1, summary: "command failed", detail: "command sh -c private-token" } })}`
              : "");
    const stderr =
      `npm error code ECONNRESET\nnpm error errno -104\nnpm error network ${fetchError.error.summary}\nnpm error network private-token https://private.invalid?key=secret\n` +
      (mode === "spoof" ? "npm error command sh -c private-token\n" : "");
    await fs.writeFile(
      join(bin, "npm"),
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(attempts)},JSON.stringify(args)+'\\n'); process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(152);\n`,
      { mode: 0o700 },
    );
    const evidence = join(f.root, "evidence");
    const wrapper = fileURLToPath(new URL("./local-fake-provider.mjs", import.meta.url));
    const command = await f.start(
      `import {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(wrapper)},'--',${JSON.stringify(process.execPath)},'-e','process.exit(99)'],{env:{PATH:${JSON.stringify(`${bin}:${process.env.PATH}`)},PI_ORB_E2E_BACKEND:'process',PI_ORB_LOCAL_FAKE_EVIDENCE:${JSON.stringify(evidence)}},stdio:'inherit'});child.on('exit',(code)=>process.exit(code));`,
    );
    await exited(command);
    const wrapperLog = await fs.readFile(join(f.root, "output-0.log"), "utf8");
    const privateRoot = wrapperLog.match(/local fake private diagnostics: (.*)/)?.[1];
    assert.ok(privateRoot?.startsWith(join(tmpdir(), "pi-orb-local-fake-")));
    t.after(() => fs.rm(privateRoot, { recursive: true, force: true }));
    assert.equal(command.exit.code, 1);
    const manifest = JSON.parse(await checkpoint(join(evidence, "manifest.json")));
    const phases = JSON.parse(await checkpoint(join(evidence, "phases.json")));
    const installs = phases.filter((p) => p.phase === "install" && p.state === "finished");
    assert.equal(installs.length, mode === "network" ? 3 : 1);
    const invocations = (await fs.readFile(attempts, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, installs.length);
    assert.equal(installs.at(-1).decision, mode === "network" ? "attempts_exhausted" : "terminal");
    assert.equal(
      installs.at(-1).npm.classification,
      mode === "network" ? "transient_network" : mode === "spoof" ? "lifecycle" : "unknown",
    );
    assert.equal(installs.at(-1).npm.clipped, mode === "clipped");
    for (const args of invocations) {
      assert.ok(args.includes("--json"));
      assert.ok(args.includes("--fetch-retries=0"));
    }
    assert.equal(manifest.error, "tool_failed");
    assert.equal(
      phases.some((p) => p.phase === "command_started" || p.phase === "service_started"),
      false,
    );
    const saved = JSON.stringify({ manifest, phases });
    for (const secret of [
      "private-token",
      "secret",
      "example.invalid",
      "private.invalid",
      "request to",
      "sh -c",
    ])
      assert.equal(saved.includes(secret), false, secret);
  });

test("npm accepts the actual ECONNREFUSED FetchError prefix and string errno", () => {
  const result = npmFailure(
    "ECONNREFUSED",
    "npm error code ECONNREFUSED\nnpm error errno ECONNREFUSED\nnpm error FetchError: request to http://127.0.0.1/pkg failed, reason: connect ECONNREFUSED",
    { summary: "FetchError: request to http://127.0.0.1/pkg failed, reason: connect ECONNREFUSED" },
  );
  assert.equal(result.classification, "transient_network");
  assert.equal(result.errno, "ECONNREFUSED");
});
test("install backoff is clipped and interruptible within the original budget", async () => {
  const clipped = installFixture([networkFailure()], [299500]);
  const waits = [];
  const wait = clipped.p.wait;
  clipped.p.wait = async (ms) => {
    waits.push(ms);
    await wait(ms);
  };
  assert.equal((await installNpm(clipped.p)).isErr(), true);
  assert.equal(
    waits.reduce((a, b) => a + b, 0),
    500,
  );
  assert.equal(clipped.calls.length, 1);
  assert.equal(clipped.phases.at(-1).decision, "budget_exhausted");
  const cancelled = installFixture([networkFailure()]);
  cancelled.p.wait = async () => cancelled.interrupt("SIGINT");
  assert.equal((await installNpm(cancelled.p)).error.type, "interrupted");
  assert.equal(cancelled.calls.length, 1);
  assert.equal(cancelled.phases.at(-1).decision, "interrupted");
});

test("malformed npm summary/detail cannot throw or admit retry", () => {
  for (const field of ["summary", "detail"])
    for (const value of [{ toString: 1 }, [], null, 1, true]) {
      const result = npmFailure("ECONNRESET", "npm error code ECONNRESET", { [field]: value });
      assert.notEqual(result.classification, "transient_network");
    }
});
test("signal termination after transient diagnostics is terminal, not a network retry", async (t) => {
  if (!linux) return t.skip("needs Linux /proc");
  const { root } = await ownedFixture(t);
  const failure = JSON.stringify({
    error: {
      code: "ECONNRESET",
      summary: "request to https://private.invalid failed, reason: reset",
      detail: "",
    },
  });
  const f = installFixture([]);
  f.p.run = (timeoutMs) =>
    runTool(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(failure)});process.stderr.write('npm error code ECONNRESET\\nnpm error errno -104\\nnpm error network request to https://private.invalid failed, reason: reset\\n');process.kill(process.pid,'SIGTERM')`,
      ],
      {},
      root,
      () => undefined,
      { timeoutMs, npm: true },
    );
  const result = await installNpm(f.p);
  assert.equal(result.isErr(), true);
  assert.equal(result.error.signal, "SIGTERM");
  assert.equal(result.error.npm.classification, "transient_network");
  assert.equal(f.phases.length, 1);
  assert.equal(f.phases[0].signal, "SIGTERM");
  assert.equal(f.phases[0].decision, "terminal");
});

test("npm fetch summary must agree across structured stdout and npm-prefixed stderr", () => {
  const summary = "request to https://private.invalid/pkg failed, reason: write ECONNRESET";
  const stdout = JSON.stringify({ error: { code: "ECONNRESET", summary, detail: "" } });
  const code = "npm error code ECONNRESET\nnpm error errno ECONNRESET\n";
  for (const stderr of [
    code,
    `${code}${summary}`,
    `${code}npm error network request to https://other.invalid failed, reason: write ECONNRESET`,
    `${code}npm error network ${summary}\nnpm error network ${summary}`,
  ])
    assert.equal(classifyNpmFailure(stdout, stderr).classification, "unknown");
  for (const prefix of ["npm error network ", "npm error ", "npm ERR! network "])
    assert.equal(
      classifyNpmFailure(stdout, `${code}${prefix}${summary}`).classification,
      "transient_network",
    );
});
