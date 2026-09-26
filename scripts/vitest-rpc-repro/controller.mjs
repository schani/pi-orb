import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, output] = process.argv.slice(2);
if (process.platform === "win32") throw Error("diagnostic requires POSIX process groups");
if (!["baseline", "handoff", "actual"].includes(mode) || !output)
  throw Error(
    "usage: node controller.mjs baseline|handoff|actual /absolute/fresh/evidence-directory",
  );
const root = resolve(output);
if (existsSync(root)) throw Error(`refusing existing evidence directory: ${root}`);
mkdirSync(root, { recursive: true });
const fixture = dirname(fileURLToPath(import.meta.url));
const repo = resolve(fixture, "../..");
const proc = spawn(
  process.execPath,
  [
    resolve(repo, "node_modules/vitest/vitest.mjs"),
    "run",
    "fixture.mjs",
    "--config",
    resolve(fixture, "vitest.config.mjs"),
    "--root",
    fixture,
    "--pool",
    "forks",
  ],
  {
    cwd: repo,
    env: { ...process.env, VITEST_RPC_REPRO: root, VITEST_RPC_CASE: mode },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let childClosed = false;
const closed = new Promise((resolve) =>
  proc.once("close", (code) => {
    childClosed = true;
    resolve(code);
  }),
);
let spawnError;
proc.once("error", (error) => {
  spawnError = error;
});
let log = "";
proc.stdout.on("data", (chunk) => {
  log += chunk;
});
proc.stderr.on("data", (chunk) => {
  log += chunk;
});
const events = () =>
  existsSync(`${root}/events.jsonl`)
    ? readFileSync(`${root}/events.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitEvent = async (name, index) => {
  const deadline = Date.now() + 24_000;
  while (Date.now() < deadline) {
    const found = events().find(
      (event) => event.event === name && (index === undefined || event.index === index),
    );
    if (found) return found;
    if (spawnError) throw spawnError;
    if (childClosed) throw Error(`Vitest exited before ${name} ${index}: ${log}`);
    await pause(10);
  }
  throw Error(`missing ${name} ${index}: ${log}`);
};
try {
  const sent = await waitEvent("rpc-request-send");
  const entered = await waitEvent("worker-entered-block", 0);
  const reply = await waitEvent("rpc-response-send");
  if (reply.id !== sent.id || reply.mono < entered.mono)
    throw Error("wrong RPC or response preceded worker block");
  for (let index = 0; index < 4; index++) {
    const start = index === 0 ? entered : await waitEvent("worker-entered-block", index);
    while (Number(process.hrtime.bigint()) / 1e6 - start.mono < 15_500) await pause(10);
    writeFileSync(`${root}/release-${index}`, "1");
  }
  const exit = await closed;
  writeFileSync(`${root}/vitest.log`, log);
  writeFileSync(
    `${root}/summary.json`,
    `${JSON.stringify({ mode, exit, targetRpcId: sent.id, events: events() }, null, 2)}\n`,
  );
  const trace = events();
  const completed = [0, 1, 2, 3].every((index) =>
    trace.some((event) => event.event === "worker-left-block" && event.index === index),
  );
  const timedOut = trace.some(
    (event) => event.event === "rpc-timeout-fired" && event.id === sent.id,
  );
  const acknowledged = trace.some(
    (event) => event.event === "rpc-response-received" && event.id === sent.id,
  );
  const passed = /fixture\.mjs \(1 test\)/.test(log) && !log.includes("Failed Tests");
  const reproduced =
    mode === "baseline"
      ? exit === 1 &&
        timedOut &&
        !acknowledged &&
        log.includes('[vitest-worker]: Timeout calling "onTaskUpdate"')
      : exit === 0 && acknowledged && !timedOut;
  if (!completed || !passed || !reproduced)
    throw Error(`invalid ${mode} outcome (Vitest exit ${exit}); inspect ${root}`);
  console.log(`${mode} classified; Vitest exit ${exit}; evidence ${root}`);
} catch (error) {
  for (let index = 0; index < 4; index++) writeFileSync(`${root}/release-${index}`, "1");
  let cleanupError;
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (killError) {
      if (killError.code !== "ESRCH") cleanupError = killError;
    }
  }
  writeFileSync(`${root}/controller-error.txt`, `process group ${proc.pid}: ${error}`);
  writeFileSync(`${root}/vitest.log`, log);
  await closed;
  if (cleanupError) throw cleanupError;
  throw error;
}
