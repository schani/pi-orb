import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { err, ok } from "neverthrow";
import {
  canonicalOrigin,
  FLING_INTEGRITY,
  inspectService,
  launch,
  npmDiagnostic,
  ownershipPorts,
  PIN,
  runTool,
  supervise,
  validateInstallPolicy,
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
  assert.equal(PIN, "a6e97a6057d4c323c341b41ea4be98b4fa59f575");
  assert.equal(
    FLING_INTEGRITY,
    "sha512-bfgwsKB5NlW5aMtaz64ZZpFlFAZCwHyPhwKHlUXTKpCUfG9WF569ibc9HXq+pL627voYm8bp96HlBbYiudyUlA==",
  );
  const lock = {
    packages: {
      "node_modules/flingit": {
        version: "0.0.71",
        integrity: FLING_INTEGRITY,
        resolved: "https://registry.npmjs.org/flingit/-/flingit-0.0.71.tgz",
      },
    },
  };
  assert.equal(validatePins(PIN, lock, "0.0.71").isOk(), true);
  for (const args of [
    ["main", lock, "0.0.71"],
    [PIN, {}, "0.0.71"],
    [PIN, null, "0.0.71"],
    [PIN, lock, "0.0.70"],
  ])
    assert.equal(validatePins(...args).error.type, "pin_mismatch");
});
test("install policy requires supported npm and an explicit cloudflared denial", () => {
  const project = { allowScripts: { cloudflared: false } };
  for (const version of ["11.19.1", "11.20.0", "12.0.0"])
    assert.equal(validateInstallPolicy(version, project).isOk(), true);
  for (const version of ["10.9.4", "11.19.0", "11.19.1-rc.1", "", "secret"])
    assert.equal(validateInstallPolicy(version, project).error.type, "npm_version_unsupported");
  for (const project of [
    null,
    {},
    { allowScripts: { cloudflared: true } },
    { allowScripts: { "cloudflared@0.7.1": false } },
  ])
    assert.equal(validateInstallPolicy("11.19.1", project).error.type, "install_policy_mismatch");
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

test("npm diagnostics retain only allowlisted anchored code/errno fields", () => {
  for (const prefix of ["npm error", "npm ERR!"])
    assert.deepEqual(
      npmDiagnostic(
        `${prefix} code ECONNRESET\n${prefix} errno -104\n${prefix} network https://token:secret@private.invalid\n${prefix} command sh -c secret`,
      ),
      { npmCode: "ECONNRESET", errno: -104, clipped: false },
    );
  for (const prefix of ["npm error", "npm ERR!"])
    assert.deepEqual(
      npmDiagnostic(
        `${prefix} code EBADENGINE\n${prefix} engine Unsupported engine https://token:secret@private.invalid`,
      ),
      { npmCode: "EBADENGINE", errno: null, clipped: false },
    );
  assert.equal(npmDiagnostic("npm error code E401\nnpm error errno ECONNREFUSED").npmCode, "E401");
  assert.equal(npmDiagnostic("npm error errno ECONNREFUSED").errno, "ECONNREFUSED");
  for (const output of [
    "",
    "code ECONNRESET",
    "npm error code secret\nnpm error errno secret",
    "npm error code ECONNRESET extra",
  ])
    assert.deepEqual(npmDiagnostic(output), { npmCode: null, errno: null, clipped: false });
});
test("conflicting or oversized npm diagnostics stay unknown", () => {
  assert.deepEqual(
    npmDiagnostic(
      "npm error code ECONNRESET\nnpm error code E401\nnpm error errno -104\nnpm error errno -111",
    ),
    { npmCode: null, errno: null, clipped: false },
  );
  assert.deepEqual(npmDiagnostic(`npm error code ECONNRESET\n${"x".repeat(65536)}`), {
    npmCode: null,
    errno: null,
    clipped: true,
  });
});
for (const [npmVersion, denied, expectedError, npmCode = "ECONNRESET", errno = -104] of [
  ["11.19.1", true, "tool_failed"],
  ["11.19.1", true, "tool_failed", "EBADENGINE", null],
  ["10.9.4", true, "npm_version_unsupported"],
  ["11.19.1", false, "install_policy_mismatch"],
])
  test(`actual npm preparation: ${npmVersion}, denial=${denied}, code=${npmCode}`, async (t) => {
    if (!linux) return t.skip("needs Linux /proc");
    const f = await ownedFixture(t);
    const bin = join(f.root, "bin"),
      evidence = join(f.root, "evidence");
    await fs.mkdir(bin);
    const lock = {
      packages: {
        "node_modules/flingit": {
          version: "0.0.71",
          integrity: FLING_INTEGRITY,
          resolved: "https://registry.npmjs.org/flingit/-/flingit-0.0.71.tgz",
        },
      },
    };
    await fs.writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst fs=require('node:fs'), a=process.argv.slice(2);if(a[0]==='init'){fs.mkdirSync(a.at(-1));fs.writeFileSync(a.at(-1)+'/package-lock.json',${JSON.stringify(JSON.stringify(lock))});fs.writeFileSync(a.at(-1)+'/package.json',${JSON.stringify(JSON.stringify({ allowScripts: { cloudflared: denied ? false : true } }))});}if(a[0]==='rev-parse')console.log('${PIN}');`,
      { mode: 0o700 },
    );
    const calls = join(f.root, "calls");
    await fs.writeFile(
      join(bin, "npm"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='--version'){console.log('${npmVersion}');process.exit(0);}console.error('npm error code ${npmCode}\\nnpm error errno ${errno}\\nnpm error command sh -c secret https://token@private.invalid');process.exit(152);`,
      { mode: 0o700 },
    );
    const wrapper = fileURLToPath(new URL("./local-fake-provider.mjs", import.meta.url));
    const child = await f.start(
      `import {spawn} from 'node:child_process';const c=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(wrapper)},'--',${JSON.stringify(process.execPath)},'-e','process.exit(99)'],{env:{PATH:${JSON.stringify(`${bin}:${process.env.PATH}`)},PI_ORB_E2E_BACKEND:'process',PI_ORB_LOCAL_FAKE_EVIDENCE:${JSON.stringify(evidence)}},stdio:'inherit'});c.on('exit',code=>process.exit(code));`,
    );
    await exited(child);
    const log = await fs.readFile(join(f.root, "output-0.log"), "utf8");
    const privateRoot = log.match(/local fake private diagnostics: (.*)/)?.[1];
    assert.ok(privateRoot?.startsWith(join(tmpdir(), "pi-orb-local-fake-")));
    t.after(() => fs.rm(privateRoot, { recursive: true, force: true }));
    assert.equal(child.exit.code, 1);
    assert.equal(
      await fs.readFile(calls, "utf8"),
      '["--version"]\n' +
        (expectedError === "tool_failed" ? '["ci","--no-audit","--no-fund"]\n' : ""),
    );
    const manifest = JSON.parse(await fs.readFile(join(evidence, "manifest.json"), "utf8"));
    const phases = JSON.parse(await fs.readFile(join(evidence, "phases.json"), "utf8"));
    const installs = phases.filter((p) => p.phase === "install" && p.state === "finished");
    assert.equal(installs.length, expectedError === "tool_failed" ? 1 : 0);
    if (expectedError === "tool_failed") {
      assert.deepEqual(installs[0].npm, { npmCode, errno, clipped: false });
      assert.equal(installs[0].code, 152);
    }
    assert.equal(manifest.error, expectedError);
    assert.equal(manifest.npm, npmVersion);
    assert.equal(
      phases.some((p) => p.phase === "command_started" || p.phase === "service_started"),
      false,
    );
    for (const secret of ["secret", "token", "private.invalid", "sh -c"])
      assert.equal(JSON.stringify({ manifest, phases }).includes(secret), false);
  });
