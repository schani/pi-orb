import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { err, ok } from "neverthrow";
import {
  canonicalOrigin,
  FLING_INTEGRITY,
  inspectService,
  launch,
  ownershipPorts,
  runTool,
  PIN,
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
