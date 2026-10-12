import { createHash, randomUUID } from "node:crypto";
import type { ResourceWarning } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { composeControlPlaneDatabase } from "../apps/control-plane/src/adapters/database.ts";
import {
  jsonParam,
  PgClient,
  type PgQueryResult,
} from "../apps/control-plane/src/adapters/pg/client.ts";
import { PgResourceSnapshots } from "../apps/control-plane/src/adapters/pg/resource-snapshots.ts";
import type { StoreError } from "../apps/control-plane/src/domain/errors.ts";
import { requestOrbStart } from "../apps/control-plane/src/domain/lifecycle.ts";
import type { OrbRow } from "../apps/control-plane/src/domain/orb.ts";
import {
  type ResourceSnapshot,
  resourceError,
} from "../apps/control-plane/src/domain/resources.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
} from "../apps/control-plane/src/testkit/fixtures.ts";

const task = new NoSimulationTask("real PostgreSQL resource retry", false);
const context = { signal: new AbortController().signal };
const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
const warnings: ResourceWarning[] = [
  { path: ".pi/skills/bad/SKILL.md", code: "invalid_metadata" },
  { path: ".pi/skills/duplicate/SKILL.md", code: "duplicate_name" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Only scheduling is wrapped; every query runs through the production PgClient. */
class LockBarrierPgClient extends PgClient {
  private nextLock: {
    entered: ReturnType<typeof deferred<number>>;
    release: ReturnType<typeof deferred<void>>;
    hold: boolean;
  } | null = null;

  watchNextOrbLock(hold = false) {
    const entered = deferred<number>();
    const release = deferred<void>();
    this.nextLock = { entered, release, hold };
    return { entered: entered.promise, release: () => release.resolve() };
  }

  override transaction<T, E>(
    f: (
      query: (sql: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
      execute: (sql: string) => ResultAsync<void, StoreError>,
    ) => Promise<Result<T, E>>,
  ): ResultAsync<T, E | StoreError> {
    return super.transaction((query, execute) =>
      f((sql, values) => {
        const barrier = this.nextLock;
        if (!barrier || !/SELECT.*FROM orbs.*FOR UPDATE/s.test(sql)) return query(sql, values);
        this.nextLock = null;
        return query("SELECT pg_backend_pid() AS pid").andThen((backend) => {
          const pid = Number(backend.rows[0]?.pid);
          if (!barrier.hold) {
            const pending = query(sql, values);
            barrier.entered.resolve(pid);
            return pending;
          }
          return query(sql, values).andThen((result) => {
            barrier.entered.resolve(pid);
            return ResultAsync.fromSafePromise(barrier.release.promise).map(() => result);
          });
        });
      }, execute),
    );
  }
}

function snapshot(orbId: string, resourceWarnings: ResourceWarning[] = warnings): ResourceSnapshot {
  const bytes = Buffer.from("Immutable repository instructions\n");
  return {
    orbId,
    commitSha: "a".repeat(40),
    instructionPath: "AGENTS.md",
    skillRoot: null,
    warnings: resourceWarnings,
    files: [
      {
        path: "AGENTS.md",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
}

async function fixture(url: string) {
  const schema = `resource_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(url);
  const scoped = new URL(url);
  // No public fallback: migrations and all pool connections own this schema.
  scoped.searchParams.set("options", `-csearch_path=${schema} -cstatement_timeout=15000`);
  const db = new LockBarrierPgClient(scoped.href);
  const other = new LockBarrierPgClient(scoped.href);
  const database = composeControlPlaneDatabase(db);
  const secondDatabase = composeControlPlaneDatabase(other);
  const close = async () => {
    try {
      const closed = await Promise.all([database.close(), secondDatabase.close()]);
      for (const result of closed) result._unsafeUnwrap();
    } finally {
      try {
        (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
      } finally {
        (await admin.end())._unsafeUnwrap();
      }
    }
  };
  try {
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    (await database.migrate())._unsafeUnwrap();
    const project = makeProjectRow(randomUUID());
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    const deps = { ...makeHarness().deps, store: database.store };
    const secondDeps = { ...makeHarness().deps, store: secondDatabase.store };
    const insert = async (state: OrbRow["state"] = "starting", overrides: Partial<OrbRow> = {}) => {
      const orb = makeOrbRow(randomUUID(), project.id, state, overrides);
      return (await database.store.insertOrb(task, orb))._unsafeUnwrap();
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
    const enqueue = async (orb: OrbRow) =>
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: randomUUID(),
          content: [{ type: "text", text: "retry work" }],
          now: 2_000,
          cancelSleep: false,
        })
      )._unsafeUnwrap();
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
    return {
      admin,
      db,
      other,
      database,
      secondDatabase,
      project,
      deps,
      secondDeps,
      insert,
      transition,
      enqueue,
      events,
      failedEvent,
      close,
    };
  } catch (error) {
    await close();
    // Vitest fixture setup must reject; production fallible APIs above return Results.
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedHistory(f: Fixture, orb: OrbRow) {
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

async function assertHistory(
  f: Fixture,
  orb: OrbRow,
  history: Awaited<ReturnType<typeof seedHistory>>,
) {
  expect(
    (await f.other.query("SELECT * FROM history_records WHERE orb_id=$1", [orb.id]))._unsafeUnwrap()
      .rows,
  ).toEqual(history);
  expect((await f.secondDatabase.store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
    replicationCursor: "kept-history",
    replicatedHeadId: "kept-history",
  });
}

async function assertWarningJson(f: Fixture, orb: OrbRow, expected: ResourceWarning[]) {
  expect(
    (
      await f.other.query(
        "SELECT resource_warnings,jsonb_typeof(resource_warnings) AS kind FROM orbs WHERE id=$1",
        [orb.id],
      )
    )._unsafeUnwrap().rows,
  ).toEqual([{ resource_warnings: expected, kind: "array" }]);
  expect(
    (
      await f.other.query(
        "SELECT manifest->'warnings' AS warnings,jsonb_typeof(manifest->'warnings') AS kind FROM orb_resource_snapshots WHERE orb_id=$1",
        [orb.id],
      )
    )._unsafeUnwrap().rows,
  ).toEqual([{ warnings: expected, kind: "array" }]);
  expect(
    (
      await f.other.query(
        "SELECT warnings,jsonb_typeof(warnings) AS kind FROM orb_resource_events WHERE orb_id=$1 AND phase='ready'",
        [orb.id],
      )
    )._unsafeUnwrap().rows,
  ).toEqual([{ warnings: expected, kind: "array" }]);
  expect((await f.secondDatabase.store.getOrb(task, orb.id))._unsafeUnwrap()).toHaveProperty(
    "resourceWarnings",
    expected,
  );
}

/** Poll the server's actual lock graph, not elapsed time or lucky JS scheduling. */
async function waitForBlocked(f: Fixture, holderPid: number, waiterPid: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = (
      await f.admin.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
        holderPid,
        waiterPid,
      ])
    )._unsafeUnwrap();
    if (result.rows[0]?.blocked === true) return;
    expect(Date.now(), "second transaction never blocked on the held orb lock").toBeLessThan(
      deadline,
    );
  }
}

if (!connectionString) {
  it.skip("needs PI_ORB_TEST_DATABASE_URL (schema create/drop permission)", () => {});
} else {
  describe("real PostgreSQL resource retry", () => {
    it("caches a failed admission until explicit Start, then fetches exactly one fresh snapshot", async () => {
      const f = await fixture(connectionString);
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
        (
          await f.db.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
            f.project.id,
            repairedUrl,
          ])
        )._unsafeUnwrap();
        const failed = await f.transition(orb, "failed");
        expect((await gate.acquire(task, failed, context)).isErr()).toBe(true);
        expect(urls).toEqual([f.project.repositoryUrl]);
        const queued = await f.enqueue(failed);
        const before = await f.events(orb);
        expect(before.map((row) => row.phase)).toEqual(["acquiring", "failed"]);
        expect(before.map((row) => row.warnings)).toEqual([[], []]);
        const started = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
        expect(started.agentAdmissionVersion).toBe(orb.agentAdmissionVersion + 1);
        expect(started.lastError).toBeNull();
        expect((await gate.initialPin(task, started))._unsafeUnwrap()).toBeNull();
        expect((await gate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
          snapshot(orb.id),
        );
        expect((await gate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
          snapshot(orb.id),
        );
        expect((await requestOrbStart(task, f.secondDeps, orb.id))._unsafeUnwrap()).toMatchObject({
          state: "starting",
          agentAdmissionVersion: 1,
        });
        expect(urls).toEqual([f.project.repositoryUrl, repairedUrl]);
        const after = await f.events(orb);
        expect(after.filter((row) => Number(row.admission_version) === 0)).toEqual(before);
        expect(after.map((row) => [Number(row.admission_version), row.phase])).toEqual([
          [0, "acquiring"],
          [0, "failed"],
          [1, "acquiring"],
          [1, "ready"],
        ]);
        expect(
          (await f.secondDatabase.store.listOrbMessages(task, orb.id))._unsafeUnwrap(),
        ).toEqual([queued.message]);
        await assertWarningJson(f, orb, warnings);
        await assertHistory(f, orb, history);
      } finally {
        await f.close();
      }
    });

    it("keeps a failed snapshot-pinned admission, warning arrays, and history without refetching", async () => {
      const f = await fixture(connectionString);
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
        expect((await gate.acquire(task, orb, context))._unsafeUnwrap()).toEqual(snapshot(orb.id));
        const failed = await f.transition(orb, "failed");
        // A snapshot must dominate even a current-generation failed event.
        await f.failedEvent(failed);
        const queued = await f.enqueue(failed);
        const before = await f.events(orb);
        (
          await f.db.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
            f.project.id,
            "https://github.com/owner/changed",
          ])
        )._unsafeUnwrap();
        const started = (await requestOrbStart(task, f.deps, orb.id))._unsafeUnwrap();
        expect(started.agentAdmissionVersion).toBe(orb.agentAdmissionVersion);
        expect(started.resourceWarnings).toEqual(warnings);
        const reopenedGate = f.secondDatabase.resourceGate({
          acquire: () => {
            calls++;
            return errAsync(resourceError("fetch", "Changed repository must not be fetched"));
          },
        });
        expect((await reopenedGate.initialPin(task, started))._unsafeUnwrap()).toBe(
          snapshot(orb.id).commitSha,
        );
        expect((await reopenedGate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
          snapshot(orb.id),
        );
        expect(calls).toBe(1);
        expect(await f.events(orb)).toEqual(before);
        expect(
          (await f.secondDatabase.store.listOrbMessages(task, orb.id))._unsafeUnwrap(),
        ).toEqual([queued.message]);
        await assertWarningJson(f, orb, warnings);
        await assertHistory(f, orb, history);

        const empty = await f.insert();
        const emptyGate = f.database.resourceGate({
          acquire: () => okAsync(snapshot(empty.id, [])),
        });
        (await emptyGate.acquire(task, empty, context))._unsafeUnwrap();
        await assertWarningJson(f, empty, []);
      } finally {
        await f.close();
      }
    });

    it.each(["transition", "queued wake"] as const)(
      "%s narrowly rotates only current failed unpinned admissions",
      async (entry) => {
        const f = await fixture(connectionString);
        try {
          const cases: Array<{
            name: string;
            state?: OrbRow["state"];
            event?: "failed" | "stale" | "acquiring" | "ready";
            pinned?: boolean;
            bump: number;
          }> = [
            { name: "current failure", event: "failed", bump: 1 },
            { name: "VM-only failure", bump: 0 },
            { name: "stale failure", event: "stale", bump: 0 },
            { name: "in-progress acquisition", event: "acquiring", bump: 0 },
            { name: "ready event", event: "ready", bump: 0 },
            { name: "snapshot dominates failure", event: "failed", pinned: true, bump: 0 },
            { name: "stopped is not failed", state: "stopped", event: "failed", bump: 0 },
          ];
          for (const c of cases) {
            const orb = await f.insert(c.state ?? "failed", { agentAdmissionVersion: 7 });
            if (c.pinned)
              (await new PgResourceSnapshots(f.db).put(snapshot(orb.id)))._unsafeUnwrap();
            if (c.event === "failed" || c.event === "stale")
              await f.failedEvent(orb, c.event === "stale" ? 6 : 7);
            else if (c.event)
              (
                await f.db.query(
                  "INSERT INTO orb_resource_events(orb_id,admission_version,phase) VALUES($1,7,$2)",
                  [orb.id, c.event],
                )
              )._unsafeUnwrap();
            const neighbor = await f.insert("failed", { agentAdmissionVersion: 7 });
            await f.failedEvent(neighbor);
            const before = await f.events(orb);
            const pin = (await new PgResourceSnapshots(f.other).get(orb.id))._unsafeUnwrap();
            const started =
              entry === "transition"
                ? (
                    await f.database.store.casTransition(task, {
                      orbId: orb.id,
                      expectedStateVersion: orb.stateVersion,
                      toState: "starting",
                      stopReason: null,
                      cancelSleep: true,
                      now: 3_000,
                    })
                  )._unsafeUnwrap()
                : (
                    await f.database.store.casStartOrbForQueuedMessage(task, {
                      orbId: orb.id,
                      expectedStateVersion: (await f.enqueue(orb)).orb.stateVersion,
                      now: 3_000,
                    })
                  )._unsafeUnwrap();
            expect(started, c.name).not.toBeNull();
            expect(started?.agentAdmissionVersion, c.name).toBe(7 + c.bump);
            expect(
              (await f.secondDatabase.store.getOrb(task, orb.id))._unsafeUnwrap(),
              c.name,
            ).toMatchObject({ state: "starting", agentAdmissionVersion: 7 + c.bump });
            expect(await f.events(orb), c.name).toEqual(before);
            expect(
              (await new PgResourceSnapshots(f.other).get(orb.id))._unsafeUnwrap(),
              c.name,
            ).toEqual(pin);
          }
        } finally {
          await f.close();
        }
      },
    );

    it.each(["Start/Start", "Start/Stop"] as const)(
      "%s serializes two clients on a real orb row lock",
      async (race) => {
        const f = await fixture(connectionString);
        let holder: ReturnType<LockBarrierPgClient["watchNextOrbLock"]> | undefined;
        let drain: Promise<unknown> | undefined;
        try {
          const failed = await f.insert("failed");
          await f.failedEvent(failed);
          const queued = await f.enqueue(failed);
          const before = await f.events(failed);
          holder = f.db.watchNextOrbLock(true);
          // In Start/Stop, Stop owns the lock before Start attempts its stale CAS.
          const winning =
            race === "Start/Start"
              ? requestOrbStart(task, f.deps, failed.id)
              : f.database.store
                  .requestOrbStop(task, {
                    orbId: failed.id,
                    expectedStateVersion: failed.stateVersion,
                    now: 5_000,
                  })
                  .map((result) => result.orb);
          const holderPid = await holder.entered;
          const waiter = f.other.watchNextOrbLock();
          const starting = requestOrbStart(task, f.secondDeps, failed.id);
          drain = Promise.all([winning, starting]);
          const waiterPid = await waiter.entered;
          expect(waiterPid).not.toBe(holderPid);
          await waitForBlocked(f, holderPid, waiterPid);
          holder.release();
          const won = (await winning)._unsafeUnwrap();
          const start = await starting;
          if (race === "Start/Start") {
            expect(start._unsafeUnwrap()).toEqual(won);
            expect(won).toMatchObject({ state: "starting", agentAdmissionVersion: 1 });
            expect(
              (await f.secondDatabase.store.listOrbMessages(task, failed.id))._unsafeUnwrap(),
            ).toEqual([queued.message]);
          } else {
            expect(start._unsafeUnwrapErr()).toMatchObject({
              type: "command_error",
              code: "conflict",
            });
            expect(won).toMatchObject({
              state: "stopping",
              stopReason: "manual",
              agentAdmissionVersion: 1,
            });
            expect(
              (await f.secondDatabase.store.listOrbMessages(task, failed.id))._unsafeUnwrap(),
            ).toEqual([{ ...queued.message, autoStart: false, updatedAt: 5_000 }]);
          }
          expect((await f.secondDatabase.store.getOrb(task, failed.id))._unsafeUnwrap()).toEqual(
            won,
          );
          expect(await f.events(failed)).toEqual(before);
        } finally {
          holder?.release();
          if (drain) await drain;
          await f.close();
        }
      },
    );
  });
}
