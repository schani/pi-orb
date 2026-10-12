import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(orbId: string): ResourceSnapshot {
  const bytes = Buffer.from("Repaired instructions\n");
  return {
    orbId,
    commitSha: "a".repeat(40),
    instructionPath: "AGENTS.md",
    skillRoot: null,
    warnings: [],
    files: [{ path: "AGENTS.md", bytes, sha256: createHash("sha256").update(bytes).digest("hex") }],
  };
}

async function withDatabase(
  run: (f: {
    client: PgClient;
    other: PgClient;
    database: ReturnType<typeof composeControlPlaneDatabase>;
    otherDatabase: ReturnType<typeof composeControlPlaneDatabase>;
    project: ReturnType<typeof makeProjectRow>;
    starterName: string;
    insert: (state?: OrbRow["state"], overrides?: Partial<OrbRow>) => Promise<OrbRow>;
  }) => Promise<void>,
) {
  if (!url) return;
  const schema = `resource_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(url);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${schema} -cstatement_timeout=10000`);
  scoped.searchParams.set("application_name", `${schema}_publisher`);
  const client = new PgClient(scoped.href);
  const starterName = `${schema}_starter`;
  scoped.searchParams.set("application_name", starterName);
  const other = new PgClient(scoped.href);
  const database = composeControlPlaneDatabase(client);
  const otherDatabase = composeControlPlaneDatabase(other);
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
    await run({
      client,
      other,
      database,
      otherDatabase,
      project,
      starterName,
      insert: async (state = "failed", overrides = {}) => {
        const orb = makeOrbRow(randomUUID(), project.id, state, overrides);
        (await database.store.insertOrb(task, orb))._unsafeUnwrap();
        return orb;
      },
    });
  } finally {
    (await database.close())._unsafeUnwrap();
    (await otherDatabase.close())._unsafeUnwrap();
    (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
    (await admin.end())._unsafeUnwrap();
  }
}

type Fixture = Parameters<Parameters<typeof withDatabase>[0]>[0];

async function failedEvent(f: Fixture, orb: OrbRow, admission = orb.agentAdmissionVersion) {
  (
    await f.client.query(
      "INSERT INTO orb_resource_events(orb_id,admission_version,phase,error_code) VALUES($1,$2,'failed','fetch')",
      [orb.id, admission],
    )
  )._unsafeUnwrap();
}

async function events(f: Fixture, orb: OrbRow) {
  return (
    await f.client.query("SELECT * FROM orb_resource_events WHERE orb_id=$1 ORDER BY id", [orb.id])
  )._unsafeUnwrap().rows;
}

function transition(f: Fixture, orb: OrbRow, toState: OrbRow["state"], cancelSleep = true) {
  return f.database.store.casTransition(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    toState,
    stopReason: null,
    cancelSleep,
    lastError: toState === "failed" ? "Resource acquisition failed" : null,
    now: 4_000,
  });
}

function enqueue(f: Fixture, orb: OrbRow, messageId: string = randomUUID()) {
  return f.database.store.enqueueOrbMessage(task, {
    orbId: orb.id,
    messageId,
    content: [{ type: "text", text: "retry work" }],
    now: 2_000,
    cancelSleep: false,
  });
}

function wake(f: Fixture, orb: OrbRow) {
  return f.database.store.casStartOrbForQueuedMessage(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    now: 3_000,
  });
}

it.skipIf(!url).each(["transition", "transition without cancelSleep", "queued wake"] as const)(
  "%s retries only a current failure without a snapshot on PostgreSQL",
  async (entry) => {
    await withDatabase(async (f) => {
      const cases: Array<{
        name: string;
        event?: "current" | "obsolete";
        snapshot?: boolean;
        state?: OrbRow["state"];
        stopReason?: OrbRow["stopReason"];
        bump: number;
      }> = [
        { name: "current failure", event: "current", bump: 1 },
        { name: "no event", bump: 0 },
        { name: "obsolete failure", event: "obsolete", bump: 0 },
        { name: "snapshot dominates failure", event: "current", snapshot: true, bump: 0 },
        { name: "snapshot without failure", snapshot: true, bump: 0 },
        { name: "stopped is not failed", state: "stopped", event: "current", bump: 0 },
        ...(["manual", "sleep"] as const).flatMap((stopReason) => [
          {
            name: `${stopReason} overlaps failure`,
            event: "current" as const,
            stopReason,
            bump: 1,
          },
          {
            name: `${stopReason} alone`,
            state: "stopped" as const,
            stopReason,
            bump: entry === "transition without cancelSleep" ? 0 : 1,
          },
        ]),
      ];
      const neighbor = await f.insert("failed", { agentAdmissionVersion: 7 });
      await failedEvent(f, neighbor);
      for (const c of cases) {
        const orb = await f.insert(c.state ?? "failed", {
          agentAdmissionVersion: 7,
          stopReason: c.stopReason ?? null,
        });
        if (c.event) await failedEvent(f, orb, c.event === "obsolete" ? 6 : 7);
        if (c.snapshot)
          (await new PgResourceSnapshots(f.client).put(snapshot(orb.id)))._unsafeUnwrap();
        const before = await events(f, orb);
        const queued = entry === "queued wake" ? (await enqueue(f, orb))._unsafeUnwrap() : null;
        const started = (
          await (queued
            ? wake(f, queued.orb)
            : transition(f, orb, "starting", entry === "transition"))
        )._unsafeUnwrap();
        expect(started, c.name).toMatchObject({
          state: "starting",
          stateVersion: 1,
          agentAdmissionVersion: 7 + c.bump,
          lastError: null,
        });
        expect(await events(f, orb), c.name).toEqual(before);
        expect(
          (await new PgResourceSnapshots(f.other).get(orb.id))._unsafeUnwrap(),
          c.name,
        ).toEqual(c.snapshot ? snapshot(orb.id) : null);
      }
    });
  },
);

it.skipIf(!url)(
  "repaired repository acquisition bypasses only the obsolete failure cache",
  async () => {
    await withDatabase(async (f) => {
      const orb = await f.insert("starting");
      const urls: string[] = [];
      const repaired = "https://github.com/owner/repaired";
      const gate = f.database.resourceGate({
        acquire: (input) => {
          urls.push(input.url);
          return input.url === repaired
            ? okAsync(snapshot(input.orbId))
            : errAsync(resourceError("fetch", "Resource acquisition failed"));
        },
      });
      expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
      (
        await f.client.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
          f.project.id,
          repaired,
        ])
      )._unsafeUnwrap();
      expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
      expect(urls).toEqual([f.project.repositoryUrl]);
      const failed = (await transition(f, orb, "failed"))._unsafeUnwrap();
      const before = await events(f, orb);
      const started = (await transition(f, failed, "starting"))._unsafeUnwrap();
      expect(started.agentAdmissionVersion).toBe(1);
      expect((await gate.initialPin(task, started))._unsafeUnwrap()).toBeNull();
      expect((await gate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
        snapshot(orb.id),
      );
      expect((await gate.acquire(task, started, context))._unsafeUnwrap()).toEqual(
        snapshot(orb.id),
      );
      expect(urls).toEqual([f.project.repositoryUrl, repaired]);
      const after = await events(f, orb);
      expect(after.filter((row) => Number(row.admission_version) === 0)).toEqual(before);
      expect(after.map((row) => [Number(row.admission_version), row.phase])).toEqual([
        [0, "acquiring"],
        [0, "failed"],
        [1, "acquiring"],
        [1, "ready"],
      ]);
      expect((await new PgResourceSnapshots(f.other).get(orb.id))._unsafeUnwrap()).toEqual(
        snapshot(orb.id),
      );
    });
  },
);

it.skipIf(!url)("one new queued wake intent admits exactly one retry", async () => {
  await withDatabase(async (f) => {
    const orb = await f.insert();
    await failedEvent(f, orb);
    const first = (await enqueue(f, orb))._unsafeUnwrap();
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      first.message,
    ]);
    const started = (await wake(f, first.orb))._unsafeUnwrap();
    assert(started);
    expect(started.agentAdmissionVersion).toBe(1);
    await failedEvent(f, started);
    const failed = (await transition(f, started, "failed"))._unsafeUnwrap();
    const before = await events(f, orb);
    for (let tick = 0; tick < 3; tick++) expect((await wake(f, failed))._unsafeUnwrap()).toBeNull();
    const duplicate = (await enqueue(f, failed, first.message.messageId))._unsafeUnwrap();
    expect(duplicate.duplicate).toBe(true);
    expect((await wake(f, duplicate.orb))._unsafeUnwrap()).toBeNull();
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      first.message,
    ]);
    const second = (await enqueue(f, failed))._unsafeUnwrap();
    const restarted = (await wake(f, second.orb))._unsafeUnwrap();
    assert(restarted);
    expect(restarted.agentAdmissionVersion).toBe(2);
    expect((await wake(f, second.orb))._unsafeUnwrapErr()).toMatchObject({
      type: "state_conflict",
    });
    expect((await f.database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual([
      first.message,
      second.message,
    ]);
    expect(await events(f, orb)).toEqual(before);
    expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(restarted);
  });
});

it.skipIf(!url).each(["transition", "queued wake"] as const)(
  "publication holding the orb lock wins over blocked %s without an admission bump",
  async (entry) => {
    await withDatabase(async (f) => {
      const orb = await f.insert("failed", { agentAdmissionVersion: 7 });
      await failedEvent(f, orb);
      const queued = entry === "queued wake" ? (await enqueue(f, orb))._unsafeUnwrap() : null;
      const before = await events(f, orb);
      const entered = deferred<number>();
      const release = deferred<void>();
      const publication = f.client.transaction(async (query) => {
        const locked = (
          await query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [orb.id])
        )._unsafeUnwrap();
        expect(locked.rowCount).toBe(1);
        (
          await query(
            "INSERT INTO orb_resource_snapshots(orb_id,commit_sha,manifest) VALUES($1,$2,$3)",
            [
              orb.id,
              "b".repeat(40),
              jsonParam({ instructionPath: null, skillRoot: null, files: [], warnings: [] }),
            ],
          )
        )._unsafeUnwrap();
        const pid = (await query("SELECT pg_backend_pid() AS pid"))._unsafeUnwrap().rows[0]?.pid;
        entered.resolve(Number(pid));
        await release.promise;
        return ok(undefined);
      });
      let starting: ReturnType<typeof transition> | ReturnType<typeof wake> | undefined;
      try {
        const publisherPid = await entered.promise;
        starting = queued
          ? f.otherDatabase.store.casStartOrbForQueuedMessage(task, {
              orbId: orb.id,
              expectedStateVersion: queued.orb.stateVersion,
              now: 3_000,
            })
          : f.otherDatabase.store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: orb.stateVersion,
              toState: "starting",
              now: 4_000,
              cancelSleep: true,
              stopReason: null,
            });
        // Observe a real lock wait; releasing before this would not exercise the race.
        await expect
          .poll(
            async () =>
              (
                await f.client.query(
                  `SELECT count(*)::int AS blocked FROM pg_stat_activity
             WHERE application_name=$1 AND wait_event_type='Lock'
               AND $2::int = ANY(pg_blocking_pids(pid))`,
                  [f.starterName, publisherPid],
                )
              )._unsafeUnwrap().rows[0]?.blocked,
          )
          .toBe(1);
        release.resolve();
        (await publication)._unsafeUnwrap();
        const started = (await starting)._unsafeUnwrap();
        assert(started);
        expect(started).toMatchObject({
          state: "starting",
          stateVersion: 1,
          agentAdmissionVersion: 7,
        });
        expect((await f.database.store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(started);
        expect((await new PgResourceSnapshots(f.other).get(orb.id))._unsafeUnwrap()).toEqual({
          orbId: orb.id,
          commitSha: "b".repeat(40),
          instructionPath: null,
          skillRoot: null,
          files: [],
          warnings: [],
        });
        expect(await events(f, orb)).toEqual(before);
      } finally {
        release.resolve();
        await publication;
        if (starting) await starting;
      }
    });
  },
);

it.skipIf(!url)(
  "retry-first rejects obsolete snapshot publication from a second client",
  async () => {
    await withDatabase(async (f) => {
      const orb = await f.insert("starting");
      const entered = deferred<void>();
      const release = deferred<ResourceSnapshot>();
      const late = f.otherDatabase
        .resourceGate({
          acquire: () => {
            entered.resolve();
            return ResultAsync.fromSafePromise(release.promise);
          },
        })
        .acquire(task, orb, context);
      try {
        await entered.promise;
        expect(
          (
            await f.database
              .resourceGate({
                acquire: () => errAsync(resourceError("fetch", "Resource acquisition failed")),
              })
              .acquire(task, orb, context)
          ).isErr(),
        ).toBe(true);
        const failed = (await transition(f, orb, "failed"))._unsafeUnwrap();
        const before = await events(f, orb);
        const started = (await transition(f, failed, "starting"))._unsafeUnwrap();
        expect(started.agentAdmissionVersion).toBe(1);
        release.resolve(snapshot(orb.id));
        expect((await late).isErr()).toBe(true);
        expect((await new PgResourceSnapshots(f.client).get(orb.id))._unsafeUnwrap()).toBeNull();
        expect(await events(f, orb)).toEqual(before);
        expect(
          (
            await f.database
              .resourceGate({
                acquire: () => okAsync(snapshot(orb.id)),
              })
              .acquire(task, started, context)
          )._unsafeUnwrap(),
        ).toEqual(snapshot(orb.id));
      } finally {
        release.resolve(snapshot(orb.id));
        await late;
      }
    });
  },
);
