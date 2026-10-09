#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, Result, ResultAsync } from "neverthrow";

export const PIN = "eaa274c562ea7b1ec6dce496a1442cfbb55b4106";
export const FLING_INTEGRITY =
  "sha512-OpjCWlRfDf7uvgYBHlNMzrAdSem7/iwe8T/K3wLaZqL/0XCf/vdNNn0yG+z4ELWhIEzmPz4UZZAYKhZ8xew84g==";
const boundary = (type, fn) => ResultAsync.fromThrowable(fn, () => ({ type }))();
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function validatePins(head, lock, installed) {
  const fling = lock?.packages?.["node_modules/flingit"];
  return head === PIN &&
    installed === "0.0.70" &&
    fling?.version === "0.0.70" &&
    fling.integrity === FLING_INTEGRITY &&
    fling.resolved === "https://registry.npmjs.org/flingit/-/flingit-0.0.70.tgz"
    ? ok(undefined)
    : err({ type: "pin_mismatch" });
}
export function canonicalOrigin(backend, gateway) {
  if (backend === "process") return ok("http://127.0.0.1:3210");
  if (
    backend !== "docker" ||
    !gateway ||
    !/^(\d{1,3}\.){3}\d{1,3}$/.test(gateway) ||
    gateway.split(".").some((v) => Number(v) > 255)
  )
    return err({ type: "bridge_gateway_missing" });
  return ok(`http://${gateway}:3210`);
}

async function stopChild(p, child, signal, stopMs) {
  const sent = await p.signal(child.pid, signal);
  if (sent.isErr()) return sent;
  for (const escalated of [false, true]) {
    if (escalated) {
      const killed = await p.signal(child.pid, "SIGKILL");
      if (killed.isErr()) return killed;
    }
    const deadline = p.now() + stopMs;
    while (p.now() < deadline) {
      const alive = await p.alive(child.pid);
      if (alive.isErr()) return alive;
      if (!alive.value && child.exit) return ok({ escalated });
      await p.wait();
    }
  }
  return err({ type: "cleanup_timeout" });
}

// Ports return Results; the supervisor never interprets failed I/O as readiness.
export async function supervise(p, settings) {
  const phases = [];
  const phase = (name, data = {}) =>
    phases.push({ phase: name, at: new Date(p.now()).toISOString(), ...data });
  const children = [];
  let outcome = { code: 1 };
  const work = async () => {
    const serviceResult = await p.start("service", settings.env);
    if (serviceResult.isErr()) return { code: 1, error: serviceResult.error };
    const service = serviceResult.value;
    children.push(service);
    phase("service_started", { pid: service.pid });
    const deadline = p.now() + settings.startupMs;
    let ready;
    while (p.now() < deadline) {
      const signal = p.interrupted();
      if (signal) return { code: signal === "SIGINT" ? 130 : 143 };
      if (service.exit) return { code: 1, error: { type: "service_exited" } };
      const inspected = await p.inspect(service.pid);
      if (inspected.isErr()) return { code: 1, error: inspected.error };
      if (inspected.value.failed) return { code: 1, error: { type: "service_failed" } };
      if (inspected.value.identity && inspected.value.migrations) {
        const health = await p.health(settings.origin);
        if (health.isOk() && health.value) {
          phase("ready", inspected.value);
          ready = { ...inspected.value };
          break;
        }
      }
      await p.wait();
    }
    if (!ready) return { code: 1, error: { type: "startup_timeout" } };
    if (service.exit) return { code: 1, error: { type: "service_exited" } };
    const signal = p.interrupted();
    if (signal) return { code: signal === "SIGINT" ? 130 : 143 };
    const started = await p.start("command", {
      ...settings.env,
      PI_ORB_FAKE_OPENAI: settings.origin,
    });
    if (started.isErr()) return { code: 1, error: started.error };
    const command = started.value;
    children.push(command);
    phase("command_started", { pid: command.pid });
    while (true) {
      const signal = p.interrupted();
      if (signal) return { code: signal === "SIGINT" ? 130 : 143 };
      // Service failure wins over a simultaneous command completion.
      if (service.exit) return { code: 1, error: { type: "service_exited" } };
      const inspected = await p.inspect(service.pid);
      if (inspected.isErr()) return { code: 1, error: inspected.error };
      const changed = ["workerPid", "workerBirth", "vitePid", "viteBirth", "restartCount"].filter(
        (field) => inspected.value[field] !== ready[field],
      );
      if (inspected.value.failed || !inspected.value.identity || changed.length) {
        phase("service_failed", {
          reason: changed.length ? "ready_identity_changed" : "service_unhealthy",
          changed,
        });
        return { code: 1, error: { type: "service_failed" } };
      }
      if (command.exit) {
        phase("command_exited", { code: command.exit.code, signal: command.exit.signal ?? null });
        return { code: command.exit.code ?? (command.exit.signal === "SIGINT" ? 130 : 143) };
      }
      await p.wait();
    }
  };
  try {
    outcome = await work();
  } finally {
    for (const child of children.reverse()) {
      const cleaned = await stopChild(p, child, p.interrupted() ?? "SIGTERM", settings.stopMs);
      phase("cleanup", {
        pid: child.pid,
        ok: cleaned.isOk(),
        error: cleaned.isErr() ? cleaned.error.type : null,
        escalated: cleaned.isOk() ? cleaned.value.escalated : null,
      });
      if (cleaned.isErr()) {
        outcome.cleanupError = cleaned.error;
        if (outcome.code === 0) outcome.code = 1;
      }
    }
  }
  return { ...outcome, phases };
}

const procRead = (fn) =>
  ResultAsync.fromThrowable(fn, (error) => ({
    type: error?.code === "ENOENT" || error?.code === "ESRCH" ? "process_gone" : "proc_read",
  }))();
async function groupMembers(group, io = fs) {
  const entries = await boundary("proc_list", () => io.readdir("/proc"));
  if (entries.isErr()) return entries;
  const members = [];
  for (const name of entries.value) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await procRead(() => io.readFile(`/proc/${name}/stat`, "utf8"));
    if (stat.isErr()) {
      if (stat.error.type === "process_gone") continue;
      return stat;
    }
    const fields = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === group && fields[0] !== "Z") members.push(Number(name));
  }
  return ok(members);
}
async function listenerOwner(group, port, io) {
  const sockets = [];
  for (const table of ["tcp", "tcp6"]) {
    const contents = await boundary("proc_sockets", () =>
      io.readFile(`/proc/net/${table}`, "utf8"),
    );
    if (contents.isErr()) return contents;
    for (const line of contents.value.trim().split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] === "0A" && Number.parseInt(f[1].split(":")[1], 16) === port)
        sockets.push({ inode: f[9], address: f[1] });
    }
  }
  const members = await groupMembers(group, io);
  if (members.isErr()) return members;
  for (const pid of members.value) {
    const descriptors = await procRead(() => io.readdir(`/proc/${pid}/fd`));
    if (descriptors.isErr()) {
      if (descriptors.error.type === "process_gone") continue;
      return descriptors;
    }
    for (const fd of descriptors.value) {
      const link = await procRead(() => io.readlink(`/proc/${pid}/fd/${fd}`));
      if (link.isErr()) {
        if (link.error.type === "process_gone") continue;
        return link;
      }
      const found = sockets.find((s) => link.value === `socket:[${s.inode}]`);
      if (found) {
        const stat = await procRead(() => io.readFile(`/proc/${pid}/stat`, "utf8"));
        if (stat.isErr()) {
          if (stat.error.type === "process_gone") continue;
          return stat;
        }
        const fields = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) !== group || fields[0] === "Z") continue;
        if (!/^\d+$/.test(fields[19] ?? "")) return err({ type: "proc_identity" });
        return ok({ workerPid: pid, workerBirth: fields[19], address: found.address });
      }
    }
  }
  return ok(undefined);
}
export async function inspectService(pid, logPath, dbPath, io = fs) {
  const log = await boundary("service_log", () => io.readFile(logPath, "utf8"));
  if (log.isErr()) return log;
  const owner = await listenerOwner(pid, 3210, io);
  if (owner.isErr()) return owner;
  const vite = await listenerOwner(pid, 5173, io);
  if (vite.isErr()) return vite;
  const db = await ResultAsync.fromThrowable(
    () => io.stat(dbPath),
    (error) => ({
      type: error?.code === "ENOENT" ? "db_missing" : "db_stat",
    }),
  )();
  if (db.isErr() && db.error.type !== "db_missing") return db;
  return ok({
    identity: Boolean(
      owner.value && vite.value && log.value.includes(`[worker] PID ${owner.value.workerPid} `),
    ),
    migrations:
      log.value.includes('[migrate] Completed "001_init"') && db.isOk() && db.value.isFile(),
    failed: /Backend server exited|\[vite\] Process exited|EADDRINUSE/.test(log.value),
    restartCount: (log.value.match(/\[worker\] (?:Files|Secrets) changed, restarting\.\.\./g) ?? [])
      .length,
    vitePid: vite.value?.workerPid,
    viteBirth: vite.value?.workerBirth,
    ...(owner.value ?? {}),
  });
}
export function launch(file, args, options, output) {
  return new Promise((resolveLaunch) => {
    // Every leader has its own known Linux group and is reaped by an exit listener.
    // detached creates the group; no unref or fire-and-forget child is used.
    const spawned = Result.fromThrowable(
      () =>
        spawn(file, args, {
          ...options,
          detached: true,
          stdio: output ? ["ignore", output.fd, output.fd] : ["ignore", "inherit", "inherit"],
        }),
      () => ({ type: "spawn_failed" }),
    )();
    if (spawned.isErr()) {
      resolveLaunch(spawned);
      return;
    }
    const child = spawned.value;
    const handle = { pid: child.pid, exit: undefined };
    child.once("error", () => {
      handle.exit = { code: 1 };
      resolveLaunch(err({ type: "spawn_failed" }));
    });
    child.once("spawn", () => resolveLaunch(ok(handle)));
    child.once("exit", (code, signal) => {
      handle.exit = { code, signal };
    });
  });
}
const wait = () => new Promise((r) => setTimeout(r, 100));
async function signalGroup(pid, signal) {
  const members = await groupMembers(pid);
  if (members.isErr()) return members;
  if (!members.value.length) return ok(undefined);
  const sent = Result.fromThrowable(
    () => process.kill(-pid, signal),
    (error) => ({ type: error?.code === "ESRCH" ? "group_gone" : "group_signal" }),
  )();
  return sent.isErr() && sent.error.type !== "group_gone" ? sent : ok(undefined);
}
export const ownershipPorts = {
  now: Date.now,
  wait,
  signal: signalGroup,
  alive: async (pid) => (await groupMembers(pid)).map((members) => members.length > 0),
};
export async function runTool(file, args, options, root, interrupted) {
  const path = join(root, `tool-${Date.now()}.log`);
  const opened = await boundary("tool_log_open", () => fs.open(path, "w", 0o600));
  if (opened.isErr()) return opened;
  const output = opened.value;
  const launched = await launch(file, args, options, output);
  if (launched.isErr()) {
    await boundary("tool_log_close", () => output.close());
    return launched;
  }
  const child = launched.value;
  const deadline = Date.now() + 300_000;
  while (!child.exit && Date.now() < deadline && !interrupted()) await wait();
  let failure;
  if (!child.exit) failure = { type: interrupted() ? "interrupted" : "tool_timeout" };
  const cleaned = await stopChild(ownershipPorts, child, interrupted() ?? "SIGTERM", 3000);
  if (cleaned.isErr()) failure = cleaned.error;
  const closed = await boundary("tool_log_close", () => output.close());
  if (closed.isErr()) return closed;
  if (failure) return err(failure);
  if (child.exit.code !== 0) return err({ type: "tool_failed", code: child.exit.code });
  return boundary("tool_log", () => fs.readFile(path, "utf8"));
}
async function freePort(port) {
  return boundary(
    "port_in_use",
    () =>
      new Promise((resolvePort, rejectPort) => {
        const server = createServer();
        server.once("error", rejectPort);
        server.listen(port, () =>
          server.close((error) => (error ? rejectPort(error) : resolvePort())),
        );
      }),
  );
}

export async function runLocalFake(command, env = process.env) {
  if (process.platform !== "linux" || command.length === 0)
    return { code: 1, error: { type: "usage_linux_command_required" } };
  let interrupt;
  const onInt = () => {
    interrupt ??= "SIGINT";
  };
  const onTerm = () => {
    interrupt ??= "SIGTERM";
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const created = await boundary("temp_directory", () =>
    fs.mkdtemp(join(tmpdir(), "pi-orb-local-fake-")),
  );
  if (created.isErr()) {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    return { code: 1, error: created.error };
  }
  const root = created.value;
  const source = join(root, "source");
  const evidence = resolve(env.PI_ORB_LOCAL_FAKE_EVIDENCE ?? `${root}-evidence`);
  const manifest = {
    pin: PIN,
    fling: "0.0.70",
    node: process.version,
    startedAt: new Date().toISOString(),
    ports: [3210, 5173],
  };
  let outcome = { code: 1, phases: [] };
  const safeEnv = {
    PATH: env.PATH,
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    CI: "true",
  };
  const localEnv = {
    ...safeEnv,
    FLING_DB_PATH: join(root, "state/local.db"),
    FLING_STORAGE_PATH: join(root, "state/storage"),
    FLING_SECRETS_PATH: join(root, "state/secrets"),
  };
  const preparationPhases = [];
  const tool = async (file, args, cwd = root) => {
    const phase = file === "npm" ? "install" : `${file}_${args[0]}`;
    preparationPhases.push({ phase, at: new Date().toISOString(), state: "started" });
    const toolEnv =
      file === "docker" && env.DOCKER_HOST ? { ...safeEnv, DOCKER_HOST: env.DOCKER_HOST } : safeEnv;
    const result = await runTool(file, args, { cwd, env: toolEnv }, root, () => interrupt);
    preparationPhases.push({
      phase,
      at: new Date().toISOString(),
      state: "finished",
      code: result.isOk() ? 0 : (result.error.code ?? 1),
      error: result.isErr() ? result.error.type : null,
    });
    return result;
  };
  const prepare = async () => {
    const dirs = await boundary("create_directories", async () => {
      for (const dir of ["home", "tmp", "state", "state/storage"])
        await fs.mkdir(join(root, dir), { recursive: true, mode: 0o700 });
      await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
    });
    if (dirs.isErr()) return dirs;
    for (const port of [3210, 5173]) {
      const free = await freePort(port);
      if (free.isErr()) return free;
    }
    let gateway;
    const backend = env.PI_ORB_E2E_BACKEND ?? "docker";
    if (backend === "docker") {
      if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://"))
        return err({ type: "local_docker_required" });
      const network = await tool("docker", [
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{json .IPAM.Config}}",
      ]);
      if (network.isErr()) return network;
      const parsed = await boundary("bridge_inspect", async () => JSON.parse(network.value));
      if (parsed.isErr()) return parsed;
      gateway = parsed.value?.[0]?.Gateway;
    }
    const origin = canonicalOrigin(backend, gateway);
    if (origin.isErr()) return origin;
    manifest.origin = origin.value;
    const git = await tool("git", ["init", "--quiet", source]);
    if (git.isErr()) return git;
    const fetch = await tool(
      "git",
      ["fetch", "--quiet", "--depth=1", "https://github.com/glideapps/fake-openai.git", PIN],
      source,
    );
    if (fetch.isErr()) return fetch;
    const checkout = await tool("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
    if (checkout.isErr()) return checkout;
    const head = await tool("git", ["rev-parse", "HEAD"], source);
    if (head.isErr()) return head;
    const lock = await boundary("lock_read", async () => {
      const raw = await fs.readFile(join(source, "package-lock.json"), "utf8");
      manifest.lockSha256 = hash(raw);
      return JSON.parse(raw);
    });
    if (lock.isErr()) return lock;
    const pinned = validatePins(head.value.trim(), lock.value, "0.0.70");
    if (pinned.isErr()) return pinned;
    const install = await tool("npm", ["ci", "--no-audit", "--no-fund"], source);
    if (install.isErr()) return install;
    const installed = await boundary(
      "fling_package",
      async () =>
        JSON.parse(await fs.readFile(join(source, "node_modules/flingit/package.json"), "utf8"))
          .version,
    );
    if (installed.isErr()) return installed;
    const verified = validatePins(head.value.trim(), lock.value, installed.value);
    if (verified.isOk()) {
      manifest.verifiedHead = PIN;
      manifest.installedFling = "0.0.70";
    }
    return verified;
  };
  try {
    const prepared = await prepare();
    if (prepared.isErr()) outcome.error = prepared.error;
    else {
      const logPath = join(root, "provider.log");
      const opened = await boundary("provider_log_open", () => fs.open(logPath, "w", 0o600));
      if (opened.isErr()) outcome.error = opened.error;
      else {
        const output = opened.value;
        const ports = {
          now: Date.now,
          wait,
          interrupted: () => interrupt,
          start: (kind, childEnv) =>
            kind === "service"
              ? launch(
                  "npm",
                  ["start", "--", "--cli", "--be-port", "3210", "--fe-port", "5173", "--verbose"],
                  { cwd: source, env: localEnv },
                  output,
                )
              : launch(command[0], command.slice(1), { cwd: process.cwd(), env: childEnv }),
          inspect: (pid) => inspectService(pid, logPath, localEnv.FLING_DB_PATH),
          health: (origin) =>
            boundary("health_transport", async () => {
              const response = await fetch(`${origin}/health`, {
                signal: AbortSignal.timeout(1000),
              });
              return response.status === 200 && (await response.json()).ok === true;
            }),
          signal: ownershipPorts.signal,
          alive: ownershipPorts.alive,
        };
        outcome = await supervise(ports, {
          origin: manifest.origin,
          env,
          startupMs: 60_000,
          stopMs: 5000,
        });
        const closed = await boundary("provider_log_close", () => output.close());
        if (closed.isErr()) {
          outcome.cleanupError = closed.error;
          if (outcome.code === 0) outcome.code = 1;
        }
        const sourceHashes = await boundary("source_hashes", async () => ({
          generatedSha256: hash(await fs.readFile(join(source, "src/worker/readme-generated.ts"))),
          bundleSha256: hash(await fs.readFile(join(source, ".fling/.dev-bundle/worker.mjs"))),
        }));
        if (sourceHashes.isOk()) Object.assign(manifest, sourceHashes.value);
      }
    }
  } finally {
    outcome.phases = [...preparationPhases, ...outcome.phases];
    if (interrupt && !outcome.phases.some((phase) => phase.phase === "command_exited"))
      outcome.code = interrupt === "SIGINT" ? 130 : 143;
    let rootRemoved = false;
    if (outcome.code === 0) {
      const removed = await boundary("temp_cleanup", () =>
        fs.rm(root, { recursive: true, force: true }),
      );
      rootRemoved = removed.isOk();
      if (removed.isErr()) {
        outcome.cleanupError = removed.error;
        outcome.code = 1;
      }
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.code = outcome.code;
    manifest.error = outcome.error?.type ?? null;
    manifest.cleanupError = outcome.cleanupError?.type ?? null;
    const saved = await boundary("evidence_write", async () => {
      await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        join(evidence, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await fs.writeFile(
        join(evidence, "phases.json"),
        `${JSON.stringify(outcome.phases, null, 2)}\n`,
        { mode: 0o600 },
      );
    });
    if (saved.isErr()) {
      outcome.evidenceError = saved.error;
      if (outcome.code === 0) outcome.code = 1;
    }
    // Keep private diagnostics on failure; never include them in the upload allowlist.
    if (!rootRemoved) console.error(`local fake private diagnostics: ${root}`);
    if (!env.PI_ORB_LOCAL_FAKE_EVIDENCE) console.error(`local fake evidence: ${evidence}`);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const separator = process.argv.indexOf("--");
  const result = await runLocalFake(separator === 2 ? process.argv.slice(3) : []);
  if (result.error || result.cleanupError || result.evidenceError)
    console.error(
      `local fake failed: ${result.error?.type ?? result.cleanupError?.type ?? result.evidenceError?.type}`,
    );
  process.exitCode = result.code;
}
