import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import { requestOrbStart } from "../../domain/lifecycle.ts";
import type { OrbRow } from "../../domain/orb.ts";
import {
  type ResourceSnapshot,
  type ResourceSource,
  resourceError,
} from "../../domain/resources.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam, type PgQueryResult } from "./client.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

const task = new NoSimulationTask("resource retry", false);
const context = { signal: new AbortController().signal };
const orbStates: readonly OrbRow["state"][] = [
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleting",
  "archiving",
  "archived",
];

function required<T>(value: T | null | undefined): T {
  assert(value !== null);
  assert(value !== undefined);
  return value;
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: required<(value: T) => void>(resolve) };
}

/** Hold a real transaction after its orb lock, not a simulated SQL response. */
class BlockingPGliteClient extends PGliteClient {
  private lockBarrier: ReturnType<BlockingPGliteClient["holdNextOrbLock"]> | null = null;

  holdNextOrbLock() {
    const entered = deferred<void>();
    const release = deferred<void>();
    const barrier = {
      entered: entered.promise,
      signal: () => entered.resolve(),
      release: () => release.resolve(),
      wait: release.promise,
    };
    this.lockBarrier = barrier;
    return barrier;
  }

  override transaction<T, E>(
    f: (
      query: (sql: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
      execute: (sql: string) => ResultAsync<void, StoreError>,
    ) => Promise<Result<T, E>>,
  ): ResultAsync<T, E | StoreError> {
    return super.transaction((query, execute) =>
      f((sql, values) => {
        const pending = query(sql, values);
        const barrier = this.lockBarrier;
        if (!barrier || !/SELECT.*FROM orbs.*FOR UPDATE/s.test(sql)) return pending;
        this.lockBarrier = null;
        return pending.andThen((result) => {
          // The lock is held until f completes and PGlite commits.
          // Release remains explicit even when an assertion fails.
          barrier.signal();
          return ResultAsync.fromSafePromise(barrier.wait).map(() => result);
        });
      }, execute),
    );
  }
}

async function fixture(db = new BlockingPGliteClient()) {
  const database = composeControlPlaneDatabase(db);
  const project = makeProjectRow(randomUUID());
  (await database.migrate())._unsafeUnwrap();
  (
    await database.users.resolveUser(
      task,
      { issuer: "test", subject: "owner", email: null },
      { id: project.ownerUserId, now: 0 },
    )
  )._unsafeUnwrap();
  (await database.store.insertProject(task, project))._unsafeUnwrap();
  const deps = { ...makeHarness().deps, store: database.store };
  const insert = async (state: OrbRow["state"] = "starting", overrides: Partial<OrbRow> = {}) => {
    const orb = makeOrbRow(randomUUID(), project.id, state, overrides);
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    return orb;
  };
  const transition = async (orb: OrbRow, toState: OrbRow["state"]) =>
    (
      await database.store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: orb.stateVersion,
        toState,
        now: 1_000,
        ...(toState === "failed" ? { lastError: "Resource acquisition failed" } : {}),
      })
    )._unsafeUnwrap();
  const enqueue = async (orb: OrbRow, messageId: string = randomUUID(), cancelSleep = true) =>
    (
      await database.store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content: [{ type: "text", text: "retry work" }],
        now: 2_000,
        cancelSleep,
      })
    )._unsafeUnwrap();
  const wake = (orb: OrbRow) =>
    database.store.casStartOrbForQueuedMessage(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: 3_000,
    });
  const events = async (orb: OrbRow) =>
    (
      await db.query("SELECT * FROM orb_resource_events WHERE orb_id=$1 ORDER BY id", [orb.id])
    )._unsafeUnwrap().rows;
  const failedEvent = async (orb: OrbRow, admission = orb.agentAdmissionVersion) => {
    (
      await db.query(
        "INSERT INTO orb_resource_events(orb_id,admission_version,phase,error_code) VALUES($1,$2,'failed','fetch')",
        [orb.id, admission],
      )
    )._unsafeUnwrap();
  };
  return { db, database, project, deps, insert, transition, enqueue, wake, events, failedEvent };
}

function snapshot(orbId: string, sha = "a".repeat(40)): ResourceSnapshot {
  const bytes = Buffer.from("Immutable repository instructions\n");
  return {
    orbId,
    commitSha: sha,
    instructionPath: "AGENTS.md",
    skillRoot: null,
    warnings: [],
    files: [{ path: "AGENTS.md", bytes, sha256: createHash("sha256").update(bytes).digest("hex") }],
  };
}

const unavailable: ResourceSource = {
  acquire: () => errAsync(resourceError("fetch", "Resource acquisition failed")),
};

async function seedHistory(f: Awaited<ReturnType<typeof fixture>>, orb: OrbRow) {
  const record = {
    id: "kept-history",
    parentId: null,
    type: "message",
    role: "user",
    content: [{ type: "text", text: "already committed work" }],
    timestamp: "2026-10-01T00:00:00.000Z",
  };
  (
    await f.db.query(
      "INSERT INTO history_records(orb_id,record_id,parent_id,record) VALUES($1,$2,NULL,$3)",
      [orb.id, record.id, jsonParam(record)],
    )
  )._unsafeUnwrap();
  (
    await f.db.query("UPDATE orbs SET replication_cursor=$2,replicated_head_id=$2 WHERE id=$1", [
      orb.id,
      record.id,
    ])
  )._unsafeUnwrap();
  return (
    await f.db.query("SELECT * FROM history_records WHERE orb_id=$1", [orb.id])
  )._unsafeUnwrap().rows;
}

it("explicit Start retries a repaired repository instead of the cached acquisition failure", async () => {
  const f = await fixture();
  try {
    const orb = await f.insert();
    const history = await seedHistory(f, orb);
    const urls: string[] = [];
    const repairedUrl = "https://github.com/owner/repaired-repository";
    const gate = f.database.resourceGate({
      acquire: (input) => {
        urls.push(input.url);
        return input.url === repairedUrl
          ? okAsync(snapshot(input.orbId))
          : errAsync(resourceError("fetch", "Resource acquisition failed"));
      },
    });
    expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
    expect((await gate.initialPin(task, orb)).isErr()).toBe(true);
    // Even a repaired source cannot bypass this admission's durable failure.
    (
      await f.db.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
        f.project.id,
        repairedUrl,
      ])
    )._unsafeUnwrap();
    expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
    expect(urls).toEqual([f.project.repositoryUrl]);
    const failed = await f.transition(orb, "failed");
    const queued = await f.enqueue(failed);
    const oldEvents = await f.events(orb);
    expect(oldEvents.map((row) => row.phase)).toEqual(["acquiring", "failed"]);
    const started = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
    expect(started.agentAdmissionVersion).toBe(orb.agentAdmissionVersion + 1);
    expect(started.lastError).toBeNull();
    expect((await gate.initialPin(task, started))._unsafeUnwrap()).toBeNull();
    const acquired = await gate.acquire(task, started, context);
    expect(acquired.isOk()).toBe(true);
    expect(acquired._unsafeUnwrap()).toEqual(snapshot(orb.id));
    expect(urls).toEqual([f.project.repositoryUrl, repairedUrl]);
    expect((await gate.acquire(task, started, context)).isOk()).toBe(true);
    expect(urls).toHaveLength(2);
    const allEvents = await f.events(orb);
    expect(allEvents.filter((row) => Number(row.admission_version) === 0)).toEqual(oldEvents);
    expect(allEvents.map((row) => [Number(row.admission_version), row.phase])).toEqual([
      [0, "acquiring"],
      [0, "failed"],
      [1, "acquiring"],
      [1, "ready"],
    ]);
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      queued.message,
    ]);
    expect(
      (await f.db.query("SELECT * FROM history_records WHERE orb_id=$1", [orb.id]))._unsafeUnwrap()
        .rows,
    ).toEqual(history);
    expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
      replicationCursor: "kept-history",
      replicatedHeadId: "kept-history",
    });
  } finally {
    (await f.database.close())._unsafeUnwrap();
  }
});

describe("resource retry admission predicate", () => {
  it.each(["transition", "transition without cancelSleep", "queued wake"] as const)(
    "%s uses only current failed event and absent snapshot",
    async (entry) => {
      const f = await fixture();
      try {
        const cases: Array<{
          name: string;
          state?: OrbRow["state"];
          event?: "failed" | "old failed" | "acquiring" | "ready";
          snapshot?: boolean;
          stopReason?: OrbRow["stopReason"];
          bump: number;
        }> = [
          { name: "current failure without snapshot", event: "failed", bump: 1 },
          { name: "VM-only failure without event", bump: 0 },
          { name: "stale failure", event: "old failed", bump: 0 },
          { name: "in-progress acquisition", event: "acquiring", bump: 0 },
          { name: "ready is not failed", event: "ready", bump: 0 },
          { name: "successful snapshot, VM failure", snapshot: true, bump: 0 },
          { name: "snapshot dominates failed event", snapshot: true, event: "failed", bump: 0 },
          { name: "stopped is not failed", state: "stopped", event: "failed", bump: 0 },
          // Manual/sleep reopening and resource retry overlap in at most one bump.
          {
            name: "manual overlaps resource failure",
            state: "failed",
            event: "failed",
            stopReason: "manual",
            bump: 1,
          },
          {
            name: "sleep overlaps resource failure",
            state: "failed",
            event: "failed",
            stopReason: "sleep",
            bump: 1,
          },
          {
            name: "failed manual without resource failure",
            state: "failed",
            stopReason: "manual",
            bump: entry === "transition without cancelSleep" ? 0 : 1,
          },
          {
            name: "failed sleep without resource failure",
            state: "failed",
            stopReason: "sleep",
            bump: entry === "transition without cancelSleep" ? 0 : 1,
          },
          {
            name: "manual without resource failure",
            state: "stopped",
            stopReason: "manual",
            bump: entry === "transition without cancelSleep" ? 0 : 1,
          },
          {
            name: "sleep without resource failure",
            state: "stopped",
            stopReason: "sleep",
            bump: entry === "transition without cancelSleep" ? 0 : 1,
          },
        ];
        for (const c of cases) {
          const orb = await f.insert(c.state ?? "failed", {
            agentAdmissionVersion: 7,
            stopReason: c.stopReason ?? null,
          });
          if (c.snapshot)
            (await new PgResourceSnapshots(f.db).put(snapshot(orb.id)))._unsafeUnwrap();
          if (c.event === "failed" || c.event === "old failed")
            await f.failedEvent(orb, c.event === "old failed" ? 6 : 7);
          else if (c.event)
            (
              await f.db.query(
                "INSERT INTO orb_resource_events(orb_id,admission_version,phase) VALUES($1,7,$2)",
                [orb.id, c.event],
              )
            )._unsafeUnwrap();
          // Other orbs' current failures must not authorize a retry here.
          const neighbor = await f.insert("failed", { agentAdmissionVersion: 7 });
          await f.failedEvent(neighbor);
          const before = await f.events(orb);
          let started: OrbRow;
          if (entry === "queued wake") {
            // Preserve manual/sleep so the wake transaction itself owns reopening.
            const queued = await f.enqueue(orb, randomUUID(), false);
            started = required((await f.wake(queued.orb))._unsafeUnwrap());
          } else {
            started = (
              await f.database.store.casTransition(task, {
                orbId: orb.id,
                expectedStateVersion: orb.stateVersion,
                toState: "starting",
                now: 4_000,
                stopReason: null,
                cancelSleep: entry === "transition",
              })
            )._unsafeUnwrap();
          }
          expect(started, c.name).not.toBeNull();
          expect(started.agentAdmissionVersion, c.name).toBe(7 + c.bump);
          expect(started.stateVersion, c.name).toBe(1);
          expect(await f.events(orb), c.name).toEqual(before);
          expect((await new PgResourceSnapshots(f.db).get(orb.id))._unsafeUnwrap(), c.name).toEqual(
            c.snapshot ? snapshot(orb.id) : null,
          );
        }
      } finally {
        (await f.database.close())._unsafeUnwrap();
      }
    },
  );
});

it("failed transitions to every nonstarting state do not renew resource admission", async () => {
  const f = await fixture();
  try {
    for (const toState of orbStates.filter((state) => state !== "starting")) {
      const orb = await f.insert("failed", { agentAdmissionVersion: 7 });
      await f.failedEvent(orb);
      const before = await f.events(orb);
      const transitioned = (
        await f.database.store.casTransition(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion,
          toState,
          now: 4_000,
          cancelSleep: false,
        })
      )._unsafeUnwrap();
      expect(transitioned, toState).toMatchObject({
        state: toState,
        stateVersion: orb.stateVersion + 1,
        agentAdmissionVersion: orb.agentAdmissionVersion,
      });
      expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap(), toState).toEqual(
        transitioned,
      );
      expect(await f.events(orb), toState).toEqual(before);
      expect((await new PgResourceSnapshots(f.db).get(orb.id))._unsafeUnwrap(), toState).toBeNull();
    }
  } finally {
    (await f.database.close())._unsafeUnwrap();
  }
});

it("every nonfailed source state starts without renewing resource admission", async () => {
  const f = await fixture();
  try {
    for (const state of orbStates.filter((state) => state !== "failed")) {
      const orb = await f.insert(state, { agentAdmissionVersion: 7 });
      await f.failedEvent(orb);
      const before = await f.events(orb);
      // Omit cancelSleep: current failed evidence alone cannot authorize these sources.
      const started = await f.transition(orb, "starting");
      expect(started, state).toMatchObject({
        state: "starting",
        stateVersion: orb.stateVersion + 1,
        agentAdmissionVersion: orb.agentAdmissionVersion,
      });
      expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap(), state).toEqual(started);
      expect(await f.events(orb), state).toEqual(before);
      expect((await new PgResourceSnapshots(f.db).get(orb.id))._unsafeUnwrap(), state).toBeNull();
    }
  } finally {
    (await f.database.close())._unsafeUnwrap();
  }
});

it.each(["transition", "queued wake"])(
  "%s rejects a stale stateVersion without changing durable retry state",
  async (entry) => {
    const f = await fixture();
    try {
      const orb = await f.insert("failed", {
        stateVersion: 5,
        agentAdmissionVersion: 7,
        stopReason: "sleep",
        sleepId: randomUUID(),
        sleepUntil: 9_000,
        lastError: "Resource acquisition failed",
      });
      await f.failedEvent(orb);
      const queued = await f.enqueue(orb, randomUUID(), false);
      const before = required((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap());
      const events = await f.events(orb);
      const messages = (await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      const result =
        entry === "transition"
          ? await f.database.store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: queued.orb.stateVersion - 1,
              toState: "starting",
              now: 4_000,
              stopReason: null,
              cancelSleep: false,
            })
          : await f.wake({ ...queued.orb, stateVersion: queued.orb.stateVersion - 1 });
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: "state_conflict" });
      expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(before);
      expect(await f.events(orb)).toEqual(events);
      expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual(
        messages,
      );
      expect((await new PgResourceSnapshots(f.db).get(orb.id))._unsafeUnwrap()).toBeNull();
    } finally {
      (await f.database.close())._unsafeUnwrap();
    }
  },
);

it("queued wake is one-shot: stranded intents and duplicate sends cannot autonomously retry", async () => {
  const f = await fixture();
  try {
    const orb = await f.insert("failed");
    const gate = f.database.resourceGate(unavailable);
    expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
    const first = await f.enqueue(orb);
    const starting = required((await f.wake(first.orb))._unsafeUnwrap());
    expect(starting.agentAdmissionVersion).toBe(1);
    expect((await gate.acquire(task, starting, context)).isErr()).toBe(true);
    const failed = await f.transition(starting, "failed");
    const before = await f.events(orb);
    for (let tick = 0; tick < 3; tick++) expect((await f.wake(failed))._unsafeUnwrap()).toBeNull();
    const duplicate = await f.enqueue(failed, first.message.messageId);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.message).toEqual(first.message);
    expect((await f.wake(duplicate.orb))._unsafeUnwrap()).toBeNull();
    expect(await f.events(orb)).toEqual(before);
    expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
      state: "failed",
      agentAdmissionVersion: 1,
    });
    const second = await f.enqueue(failed);
    const restarted = required((await f.wake(second.orb))._unsafeUnwrap());
    expect(restarted.agentAdmissionVersion).toBe(2);
    expect((await f.wake(second.orb))._unsafeUnwrapErr()).toMatchObject({ type: "state_conflict" });
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      first.message,
      second.message,
    ]);
    expect(await f.events(orb)).toEqual(before);
  } finally {
    (await f.database.close())._unsafeUnwrap();
  }
});

it("rejects late successful publication from the failed admission after explicit Start", async () => {
  const f = await fixture();
  const sourceEntered = deferred<void>();
  const publication = deferred<ResourceSnapshot>();
  let late:
    | ReturnType<
        ReturnType<ReturnType<typeof composeControlPlaneDatabase>["resourceGate"]>["acquire"]
      >
    | undefined;
  try {
    const orb = await f.insert();
    const lateGate = f.database.resourceGate({
      acquire: () => {
        sourceEntered.resolve();
        return ResultAsync.fromSafePromise(publication.promise);
      },
    });
    late = lateGate.acquire(task, orb, context);
    await sourceEntered.promise;
    expect((await f.database.resourceGate(unavailable).acquire(task, orb, context)).isErr()).toBe(
      true,
    );
    await f.transition(orb, "failed");
    const oldEvents = await f.events(orb);
    const started = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
    // Publish while the new admission has no snapshot: the old pin must not win.
    publication.resolve(snapshot(orb.id, "b".repeat(40)));
    expect((await late).isErr()).toBe(true);
    expect((await new PgResourceSnapshots(f.db).get(orb.id))._unsafeUnwrap()).toBeNull();
    expect(await f.events(orb)).toEqual(oldEvents);
    const freshGate = f.database.resourceGate({ acquire: () => okAsync(snapshot(orb.id)) });
    expect((await freshGate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
      snapshot(orb.id),
    );
    expect((await f.events(orb)).filter((row) => Number(row.admission_version) === 0)).toEqual(
      oldEvents,
    );
  } finally {
    // Also drain the source if an earlier assertion failed.
    publication.resolve(snapshot("00000000-0000-4000-8000-000000000099"));
    if (late) await late;
    (await f.database.close())._unsafeUnwrap();
  }
});

it("successful snapshots remain immutable across VM failure, repair, and manual Stop/Start", async () => {
  const f = await fixture();
  try {
    const orb = await f.insert();
    const history = await seedHistory(f, orb);
    let calls = 0;
    const gate = f.database.resourceGate({
      acquire: () => {
        calls++;
        return okAsync(snapshot(orb.id));
      },
    });
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    const events = await f.events(orb);
    const failed = await f.transition(orb, "failed");
    const message = await f.enqueue(failed);
    (
      await f.db.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
        f.project.id,
        "https://github.com/owner/changed",
      ])
    )._unsafeUnwrap();
    const started = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
    expect(started.agentAdmissionVersion).toBe(0);
    expect((await gate.acquire(task, started, context))._unsafeUnwrap()).toEqual(snapshot(orb.id));
    const stopped = (
      await f.database.store.requestOrbStop(task, {
        orbId: orb.id,
        expectedStateVersion: started.stateVersion,
        now: 5_000,
      })
    )._unsafeUnwrap().orb;
    const terminal = await f.transition(stopped, "stopped");
    const reopened = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
    expect(reopened.agentAdmissionVersion).toBe(2);
    const changedSource = f.database.resourceGate({
      acquire: () => {
        calls++;
        return okAsync(snapshot(orb.id, "c".repeat(40)));
      },
    });
    expect((await changedSource.acquire(task, reopened, context))._unsafeUnwrap()).toEqual(
      snapshot(orb.id),
    );
    expect(calls).toBe(1);
    expect(await f.events(orb)).toEqual([
      ...events,
      {
        ...required(events[1]),
        id: expect.any(Number),
        admission_version: reopened.agentAdmissionVersion,
      },
    ]);
    expect(terminal.agentAdmissionVersion).toBe(1);
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      { ...message.message, autoStart: false, updatedAt: 5_000 },
    ]);
    expect(
      (await f.db.query("SELECT * FROM history_records WHERE orb_id=$1", [orb.id]))._unsafeUnwrap()
        .rows,
    ).toEqual(history);
  } finally {
    (await f.database.close())._unsafeUnwrap();
  }
});

it("a wake holding the transaction lock wins over concurrent Start without a double bump", async () => {
  const f = await fixture();
  let barrier: ReturnType<BlockingPGliteClient["holdNextOrbLock"]> | undefined;
  try {
    const failed = await f.insert("failed");
    await f.failedEvent(failed);
    const queued = await f.enqueue(failed);
    barrier = f.db.holdNextOrbLock();
    const waking = f.wake(queued.orb);
    await barrier.entered;
    const starting = requestOrbStart(task, f.deps, failed.id);
    barrier.release();
    const woke = required((await waking)._unsafeUnwrap());
    const started = (await starting)._unsafeUnwrap();
    expect(woke.agentAdmissionVersion).toBe(1);
    expect(started).toEqual(woke);
    expect((await f.database.store.getOrb(task, failed.id))._unsafeUnwrap()).toEqual(woke);
    expect((await f.database.store.listOrbMessages(task, failed.id))._unsafeUnwrap()).toEqual([
      queued.message,
    ]);
  } finally {
    barrier?.release();
    (await f.database.close())._unsafeUnwrap();
  }
});

it("Stop holding the transaction lock retires a concurrent wake and explicit Start", async () => {
  const f = await fixture();
  let barrier: ReturnType<BlockingPGliteClient["holdNextOrbLock"]> | undefined;
  try {
    const failed = await f.insert("failed");
    await f.failedEvent(failed);
    const queued = await f.enqueue(failed);
    barrier = f.db.holdNextOrbLock();
    const stopping = f.database.store.requestOrbStop(task, {
      orbId: failed.id,
      expectedStateVersion: failed.stateVersion,
      now: 5_000,
    });
    await barrier.entered;
    const waking = f.wake(queued.orb);
    const starting = requestOrbStart(task, f.deps, failed.id);
    barrier.release();
    const stopped = (await stopping)._unsafeUnwrap().orb;
    expect((await waking)._unsafeUnwrapErr()).toMatchObject({ type: "state_conflict" });
    expect((await starting)._unsafeUnwrapErr()).toMatchObject({
      type: "command_error",
      code: "conflict",
    });
    expect(stopped).toMatchObject({
      state: "stopping",
      stopReason: "manual",
      agentAdmissionVersion: 1,
    });
    const terminal = await f.transition(stopped, "stopped");
    expect((await f.wake(terminal))._unsafeUnwrap()).toBeNull();
    expect((await f.database.store.listOrbMessages(task, failed.id))._unsafeUnwrap()).toEqual([
      { ...queued.message, autoStart: false, updatedAt: 5_000 },
    ]);
    expect(
      (await requestOrbStart(task, f.deps, failed.id))._unsafeUnwrap().agentAdmissionVersion,
    ).toBe(2);
  } finally {
    barrier?.release();
    (await f.database.close())._unsafeUnwrap();
  }
});
