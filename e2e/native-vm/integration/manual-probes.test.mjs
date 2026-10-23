import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
test("preemption proves recovery without sampling starting", async () => {
  const source = (await readFile(new URL("./preemption.mjs", import.meta.url), "utf8")).replace(
    /^import .*;$/gm,
    "",
  );
  const fixture = { orbId: "owned", gcpProject: "fixture", zone: "fixture" };
  let reads = 0;
  const rows = [
    { state: "running", stateVersion: 4, stateChangedAt: "2026-10-22T01:00:00Z" },
    { state: "running", stateVersion: 6, stateChangedAt: "2026-10-22T01:01:00Z" },
  ];
  const writes = [];
  await new AsyncFunction(
    "assert",
    "execFile",
    "readFileSync",
    "writeFileSync",
    "promisify",
    "waitFor",
    "fetch",
    "process",
    "console",
    source,
  )(
    assert,
    (_command, args, done) =>
      done(
        null,
        args.includes("list")
          ? JSON.stringify([{ name: "pi-orb-owned-i1", status: "RUNNING" }])
          : "",
        "",
      ),
    () => JSON.stringify(fixture),
    (path, data) => writes.push([path, JSON.parse(data)]),
    (execute) =>
      (...args) =>
        new Promise((resolve, reject) =>
          execute(...args, (error, stdout, stderr) =>
            error ? reject(error) : resolve({ stdout, stderr }),
          ),
        ),
    async (_label, poll) => {
      assert(await poll());
    },
    async () => ({ json: async () => rows[reads++] }),
    { env: {} },
    { log() {} },
  );
  assert(writes.length > 0);
});
