import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { OrbRow } from "../../domain/orb.ts";
import { type ResourceSnapshot, resourceError } from "../../domain/resources.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam, PgClient } from "./client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
const task = new NoSimulationTask("PostgreSQL resource retry", false);
const context = { signal: new AbortController().signal };
const failure = () => errAsync(resourceError("fetch", "Resource acquisition failed"));
const snapshot = (orbId: string): ResourceSnapshot => ({
  orbId,
  commitSha: "a".repeat(40),
  instructionPath: null,
  skillRoot: null,
  files: [],
  warnings: [],
});
async function unwrap<T, E>(result: PromiseLike<Result<T, E>>) {
  return (await result)._unsafeUnwrap();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(client: PgClient, other: PgClient, starterName: string) {
  const database = composeControlPlaneDatabase(client);
  const otherDatabase = composeControlPlaneDatabase(other);
  const project = makeProjectRow(randomUUID());
  const query = async (sql: string, params?: unknown[]) =>
    (await unwrap(client.query(sql, params))).rows;
  const cas = (orb: OrbRow, toState: "starting" | "failed", cancelSleep = true, db = database) =>
    db.store.casTransition(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      toState,
      stopReason: null,
      lastError: toState === "failed" ? "Resource acquisition failed" : null,
      cancelSleep,
      now: 4_000,
    });
  const start = (orb: OrbRow, queued = false, cancelSleep = true, db = database) =>
    queued
      ? db.store.casStartOrbForQueuedMessage(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion,
          now: 3_000,
        })
      : cas(orb, "starting", cancelSleep, db);
  return {
    client,
    database,
    otherDatabase,
    project,
    starterName,
    query,
    start,
    insert: async (state: OrbRow["state"] = "failed", overrides: Partial<OrbRow> = {}) => {
      const orb = makeOrbRow(randomUUID(), project.id, state, overrides);
      await unwrap(database.store.insertOrb(task, orb));
      return orb;
    },
    fail: (orb: OrbRow) => unwrap(cas(orb, "failed")),
    event: (orb: OrbRow, admission = orb.agentAdmissionVersion, phase = "failed") =>
      query(
        "INSERT INTO orb_resource_events(orb_id,admission_version,phase,error_code) VALUES($1,$2,$3,$4)",
        [orb.id, admission, phase, phase === "failed" ? "fetch" : null],
      ),
    events: (orb: OrbRow) =>
      query("SELECT * FROM orb_resource_events WHERE orb_id=$1 ORDER BY id", [orb.id]),
    snapshot: (orb: OrbRow) => unwrap(new PgResourceSnapshots(other).get(orb.id)),
    enqueue: (orb: OrbRow, messageId: string = randomUUID()) =>
      unwrap(
        database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content: [{ type: "text", text: "retry work" }],
          now: 2_000,
          cancelSleep: false,
        }),
      ),
    messages: (orb: OrbRow) => unwrap(database.store.listOrbMessages(task, orb.id)),
    get: (orb: OrbRow) => unwrap(database.store.getOrb(task, orb.id)),
  };
}

async function withDatabase(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  if (!url) return;
  const schema = `resource_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(url);
  const scoped = new URL(url);
  scoped.searchParams.set(
    "options",
    `-csearch_path=${schema} -cstatement_timeout=10000 -cdefault_transaction_isolation=read\\ committed`,
  );
  const client = new PgClient(scoped.href);
  scoped.searchParams.set("application_name", `${schema}_starter`);
  const f = fixture(client, new PgClient(scoped.href), `${schema}_starter`);
  try {
    await unwrap(admin.query(`CREATE SCHEMA ${schema}`));
    await unwrap(f.database.migrate());
    await unwrap(
      f.database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: f.project.ownerUserId, now: 0 },
      ),
    );
    await unwrap(f.database.store.insertProject(task, f.project));
    await run(f);
  } finally {
    await unwrap(f.database.close());
    await unwrap(f.otherDatabase.close());
    await unwrap(admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await unwrap(admin.end());
  }
}

const test = it
  .extend<{ f: ReturnType<typeof fixture> }>({
    f: async ({ task: _task }, use) => withDatabase(use),
  })
  .skipIf(!url);

test.for(["transition", "transition without cancelSleep", "queued wake"] as const)(
  "%s retries only a current failure without a snapshot on PostgreSQL",
  async (entry, { f }) => {
    // name, phase, admission, snapshot, state, stop reason, bump
    const stopBump = entry === "transition without cancelSleep" ? 0 : 1;
    const cases = [
      ["current failure", "failed", 7, false, "failed", null, 1],
      ["no event", null, 7, false, "failed", null, 0],
      ["obsolete failure", "failed", 6, false, "failed", null, 0],
      ["snapshot dominates failure", "failed", 7, true, "failed", null, 0],
      ["snapshot without failure", null, 7, true, "failed", null, 0],
      ["acquiring is not failed", "acquiring", 7, false, "failed", null, 0],
      ["ready is not failed", "ready", 7, false, "failed", null, 0],
      ["stopped is not failed", "failed", 7, false, "stopped", null, 0],
      ["manual overlaps failure", "failed", 7, false, "failed", "manual", 1],
      ["sleep overlaps failure", "failed", 7, false, "failed", "sleep", 1],
      ["manual alone", null, 7, false, "stopped", "manual", stopBump],
      ["sleep alone", null, 7, false, "stopped", "sleep", stopBump],
    ] as const;
    await f.event(await f.insert("failed", { agentAdmissionVersion: 7 }));
    for (const [name, phase, admission, pinned, state, stopReason, bump] of cases) {
      const orb = await f.insert(state, { agentAdmissionVersion: 7, stopReason });
      if (phase) await f.event(orb, admission, phase);
      if (pinned) await unwrap(new PgResourceSnapshots(f.client).put(snapshot(orb.id)));
      const before = await f.events(orb);
      const queued = entry === "queued wake";
      const intent = queued ? (await f.enqueue(orb)).orb : orb;
      expect(await unwrap(f.start(intent, queued, entry === "transition")), name).toMatchObject({
        state: "starting",
        stateVersion: 1,
        agentAdmissionVersion: 7 + bump,
        lastError: null,
      });
      expect(await f.events(orb), name).toEqual(before);
      expect(await f.snapshot(orb), name).toEqual(pinned ? snapshot(orb.id) : null);
    }
  },
);

test("repaired acquisition bypasses obsolete failure cache", async ({ f }) => {
  const orb = await f.insert("starting");
  const urls: string[] = [];
  const repaired = "https://github.com/owner/repaired";
  const gate = f.database.resourceGate({
    acquire: (input) => {
      urls.push(input.url);
      return input.url === repaired ? okAsync(snapshot(input.orbId)) : failure();
    },
  });
  expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
  await f.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [f.project.id, repaired]);
  expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
  expect(urls).toEqual([f.project.repositoryUrl]);
  const failed = await f.fail(orb);
  const before = await f.events(orb);
  const started = await unwrap(f.start(failed));
  assert(started);
  expect(started.agentAdmissionVersion).toBe(1);
  expect(await unwrap(gate.initialPin(task, started))).toBeNull();
  for (let call = 0; call < 2; call++)
    expect(await unwrap(gate.acquire(task, started, context))).toEqual(snapshot(orb.id));
  expect(urls).toEqual([f.project.repositoryUrl, repaired]);
  const after = await f.events(orb);
  expect(after.filter((row) => Number(row.admission_version) === 0)).toEqual(before);
  expect(after.map((row) => [Number(row.admission_version), row.phase])).toEqual([
    [0, "acquiring"],
    [0, "failed"],
    [1, "acquiring"],
    [1, "ready"],
  ]);
  expect(after.every((row) => row.orb_id === orb.id)).toBe(true);
  expect(await f.snapshot(orb)).toEqual(snapshot(orb.id));
});

test("one new queued wake intent admits exactly one retry", async ({ f }) => {
  const orb = await f.insert();
  await f.event(orb);
  const first = await f.enqueue(orb);
  expect(await f.messages(orb)).toEqual([first.message]);
  const started = await unwrap(f.start(first.orb, true));
  assert(started);
  expect(started.agentAdmissionVersion).toBe(1);
  await f.event(started);
  const failed = await f.fail(started);
  const before = await f.events(orb);
  for (let tick = 0; tick < 3; tick++) expect(await unwrap(f.start(failed, true))).toBeNull();
  const duplicate = await f.enqueue(failed, first.message.messageId);
  expect(duplicate.duplicate).toBe(true);
  expect(await unwrap(f.start(duplicate.orb, true))).toBeNull();
  expect(await f.messages(orb)).toEqual([first.message]);
  const second = await f.enqueue(failed);
  const restarted = await unwrap(f.start(second.orb, true));
  assert(restarted);
  expect(restarted.agentAdmissionVersion).toBe(2);
  expect((await f.start(second.orb, true))._unsafeUnwrapErr()).toMatchObject({
    type: "state_conflict",
  });
  expect(await f.messages(orb)).toEqual([first.message, second.message]);
  expect(await f.events(orb)).toEqual(before);
  expect(await f.get(orb)).toEqual(restarted);
});

test.for(["transition", "queued wake"] as const)(
  "publication-first blocks %s without an admission bump",
  async (entry, { f }) => {
    const orb = await f.insert("failed", { agentAdmissionVersion: 7 });
    await f.event(orb);
    const queued = entry === "queued wake";
    const intent = queued ? (await f.enqueue(orb)).orb : orb;
    const before = await f.events(orb);
    const entered = deferred<number>();
    const release = deferred<void>();
    const published = snapshot(orb.id);
    const publication = f.client.transaction(async (query) => {
      const isolation = await unwrap(query("SHOW transaction_isolation"));
      expect(isolation.rows[0]?.transaction_isolation).toBe("read committed");
      const locked = await unwrap(query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [orb.id]));
      expect(locked.rowCount).toBe(1);
      const { orbId, commitSha, ...manifest } = published;
      const insert =
        "INSERT INTO orb_resource_snapshots(orb_id,commit_sha,manifest) VALUES($1,$2,$3)";
      await unwrap(query(insert, [orbId, commitSha, jsonParam(manifest)]));
      entered.resolve(Number((await unwrap(query("SELECT pg_backend_pid() AS pid"))).rows[0]?.pid));
      await release.promise;
      return ok(undefined);
    });
    let starting: ReturnType<typeof f.start> | undefined;
    try {
      const publisherPid = await entered.promise;
      starting = f.start(intent, queued, true, f.otherDatabase);
      // Observe a real lock wait before releasing the publisher.
      const blocked = async () => {
        const rows = await f.query(
          `SELECT count(*)::int AS blocked FROM pg_stat_activity
           WHERE application_name=$1 AND wait_event_type='Lock'
             AND $2::int = ANY(pg_blocking_pids(pid))`,
          [f.starterName, publisherPid],
        );
        return rows[0]?.blocked;
      };
      await expect.poll(blocked).toBe(1);
      release.resolve();
      await unwrap(publication);
      const started = await unwrap(starting);
      assert(started);
      expect(started).toMatchObject({
        state: "starting",
        stateVersion: 1,
        agentAdmissionVersion: 7,
      });
      expect(await f.get(orb)).toEqual(started);
      expect(await f.snapshot(orb)).toEqual(published);
      expect(await f.events(orb)).toEqual(before);
    } finally {
      release.resolve();
      await publication;
      if (starting) await starting;
    }
  },
);

test("retry-first rejects a second client’s obsolete publication", async ({ f }) => {
  const orb = await f.insert("starting");
  const entered = deferred<void>();
  const release = deferred<ResourceSnapshot>();
  const lateGate = f.otherDatabase.resourceGate({
    acquire: () => {
      entered.resolve();
      return ResultAsync.fromSafePromise(release.promise);
    },
  });
  const late = lateGate.acquire(task, orb, context);
  const failedGate = f.database.resourceGate({ acquire: failure });
  const repairedGate = f.database.resourceGate({ acquire: () => okAsync(snapshot(orb.id)) });
  try {
    await entered.promise;
    expect((await failedGate.acquire(task, orb, context)).isErr()).toBe(true);
    const failed = await f.fail(orb);
    const before = await f.events(orb);
    const started = await unwrap(f.start(failed));
    assert(started);
    expect(started.agentAdmissionVersion).toBe(1);
    release.resolve(snapshot(orb.id));
    expect((await late).isErr()).toBe(true);
    expect(await f.snapshot(orb)).toBeNull();
    expect(await f.events(orb)).toEqual(before);
    expect(await unwrap(repairedGate.acquire(task, started, context))).toEqual(snapshot(orb.id));
  } finally {
    release.resolve(snapshot(orb.id));
    await late;
  }
});
