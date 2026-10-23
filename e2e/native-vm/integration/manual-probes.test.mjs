import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
test("preemption proves recovery without sampling starting", async () => {
  const source = (await readFile(new URL("./preemption.mjs", import.meta.url), "utf8")).replace(
    /^import .*;$/gm,
    "",
  );
  assert.doesNotMatch(source, /\bimport\b/);
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

test("unknown control stage is rejected before fixture reads or operations", async () => {
  const source = (await readFile(new URL("./control.mjs", import.meta.url), "utf8")).replace(
    /^import .*;$/gm,
    "",
  );
  assert.doesNotMatch(source, /\bimport\b/);
  let touched = false;
  await assert.rejects(
    new AsyncFunction("assert", "readFileSync", "process", source)(
      assert,
      () => {
        touched = true;
        throw Error("fixture read");
      },
      { env: {}, argv: ["node", "control", "typo"] },
    ),
    /unknown.*stage/i,
  );
  assert.equal(touched, false);
});

test("application probe expectations come from the owned fixture", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "application-expectations-test-"));
  const expected = root + "/application-expectations.json";
  const commit = "a".repeat(40);
  await writeFile(
    expected,
    JSON.stringify({ githubLogin: "fixture-login", checkoutCommit: commit }),
  );
  const script = await readFile(new URL("./application-check.sh", import.meta.url), "utf8");
  const boundary = 'test "$NATIVE_VM_SECRET"';
  assert.equal(script.split(boundary).length, 2);
  const source = script.split(boundary)[0];
  assert.doesNotMatch(source, /npm|testcontainers|docker/);
  try {
    for (const [login, sha, accepted] of [
      ["fixture-login", commit, true],
      ["wrong-login", commit, false],
      ["fixture-login", "b".repeat(40), false],
    ]) {
      const result = spawnSync(
        "bash",
        [
          "-ec",
          `
        id() { :; }; sudo() { :; }; cd() { test "$1" = /workspace/repo; }
        gh() { printf '%s' '${login}'; }
        git() { printf '%s' '${sha}'; }
        ${source}
      `,
          "application-check",
          expected,
        ],
        { encoding: "utf8", timeout: 3000, env: { PATH: process.env.PATH } },
      );
      assert.equal(result.status === 0, accepted, result.stderr);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready control publishes login and accepted checkout from its owned fixture", async () => {
  const source = (await readFile(new URL("./control.mjs", import.meta.url), "utf8")).replace(
    /^import .*;$/gm,
    "",
  );
  assert.doesNotMatch(source, /\bimport\b/);
  const fixture = { orbId: "owned", expectedGitHubLogin: "fixture-login" };
  const row = { state: "running", checkoutCommit: "c".repeat(40) };
  const writes = [];
  await new AsyncFunction(
    "assert",
    "readFileSync",
    "writeFileSync",
    "api",
    "waitFor",
    "fetch",
    "process",
    "console",
    source,
  )(
    assert,
    () => JSON.stringify(fixture),
    (path, data) => writes.push([path, JSON.parse(data)]),
    async () => ({ body: row }),
    async (_label, poll) => {
      const result = await poll();
      assert(result);
      return result;
    },
    async () => ({ ok: true }),
    { env: {}, argv: ["node", "control", "ready"] },
    { log() {} },
  );
  assert.deepEqual(writes.find(([path]) => path.endsWith("application-expectations.json"))?.[1], {
    githubLogin: "fixture-login",
    checkoutCommit: row.checkoutCommit,
  });
});
