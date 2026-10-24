import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { openOrbSqlFixture } from "../../testkit/sql-fixture.ts";
import { jsonParam } from "./client.ts";
import { PgResourceGate } from "./resource-gate.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

it("publishes the pin once, restores without Git, and fences Stop before late publication", async () => {
  const { db, task, orb } = await openOrbSqlFixture("resources", "starting");
  {
    let calls = 0;
    const gate = new PgResourceGate(db, {
      acquire: () => {
        calls++;
        return okAsync({
          orbId: orb.id,
          commitSha: "a".repeat(40),
          instructionPath: null,
          skillRoot: null,
          files: [],
        });
      },
    });
    const context = { signal: new AbortController().signal };
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(calls).toBe(1);
    expect((await gate.initialPin(task, orb))._unsafeUnwrap()).toBe("a".repeat(40));
    (
      await db.query("DELETE FROM orb_resource_snapshots WHERE orb_id=$1", [orb.id])
    )._unsafeUnwrap();
    const late = new PgResourceGate(db, {
      acquire: () =>
        db
          .query("UPDATE orbs SET agent_admission_version=1 WHERE id=$1", [orb.id])
          .mapErr(() => resourceError("storage", "test"))
          .map(() => ({
            orbId: orb.id,
            commitSha: "b".repeat(40),
            instructionPath: null,
            skillRoot: null,
            files: [],
          })),
    });
    expect((await late.acquire(task, orb, context)).isErr()).toBe(true);
    expect(
      (await db.query("SELECT count(*) AS n FROM orb_resource_snapshots"))._unsafeUnwrap().rows[0]
        ?.n,
    ).toBe(0);
    const current = { ...orb, agentAdmissionVersion: 1 };
    const failed = new PgResourceGate(db, {
      acquire: () => errAsync({ ...resourceError("fetch", "sanitized"), reason: "missing_ref" }),
    });
    const log = vi.spyOn(task, "log");
    expect((await failed.acquire(task, current, context)).isErr()).toBe(true);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(/resources\.failed .*code=fetch reason=missing_ref/),
    );
    expect((await failed.initialPin(task, current)).isErr()).toBe(true);
  }
});

async function resourceTest() {
  const { db, task, orb } = await openOrbSqlFixture("resources", "starting");
  const snapshot = {
    orbId: orb.id,
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: null,
    files: [],
  };
  const context = { signal: new AbortController().signal };
  return { db, task, orb, snapshot, context };
}

it("readies without a fabricated snapshot, then pins the first attached repository", async () => {
  const { db, task, orb, snapshot, context } = await resourceTest();
  const acquire = vi.fn(() => okAsync(snapshot));
  const gate = new PgResourceGate(db, { acquire });
  const log = vi.spyOn(task, "log");
  {
    (
      await db.query("UPDATE projects SET repository_url=NULL WHERE id=$1", [orb.projectId])
    )._unsafeUnwrap();
    expect((await gate.acquire(task, orb, context))._unsafeUnwrap()).toBeNull();
    expect((await gate.acquire(task, orb, context))._unsafeUnwrap()).toBeNull();
    expect((await gate.initialPin(task, orb))._unsafeUnwrap()).toBeNull();
    expect((await new PgResourceSnapshots(db).get(orb.id))._unsafeUnwrap()).toBeNull();
    expect(
      (
        await db.query(
          "SELECT phase,commit_sha,file_count,byte_count FROM orb_resource_events WHERE orb_id=$1",
          [orb.id],
        )
      )._unsafeUnwrap().rows,
    ).toEqual([{ phase: "ready", commit_sha: null, file_count: 0, byte_count: 0 }]);
    expect(
      log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("resources.ready")),
    ).toHaveLength(1);
    expect(acquire).not.toHaveBeenCalled();
    (
      await db.query(
        "UPDATE orbs SET agent_admission_version=agent_admission_version+1 WHERE id=$1",
        [orb.id],
      )
    )._unsafeUnwrap();
    expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
    expect(acquire).not.toHaveBeenCalled();

    let current = orb;
    for (const repositoryUrl of ["https://github.com/o/attached", null]) {
      (
        await db.query("UPDATE projects SET repository_url=$2 WHERE id=$1", [
          orb.projectId,
          repositoryUrl,
        ])
      )._unsafeUnwrap();
      current = { ...current, agentAdmissionVersion: current.agentAdmissionVersion + 1 };
      (
        await db.query("UPDATE orbs SET agent_admission_version=$2 WHERE id=$1", [
          orb.id,
          current.agentAdmissionVersion,
        ])
      )._unsafeUnwrap();
      const reopened = new PgResourceGate(db, { acquire });
      expect((await reopened.acquire(task, current, context))._unsafeUnwrap()).toEqual({
        ...snapshot,
        warnings: [],
      });
      expect((await reopened.initialPin(task, current))._unsafeUnwrap()).toBe(snapshot.commitSha);
      expect(acquire).toHaveBeenCalledTimes(1);
    }
    expect(acquire).toHaveBeenCalledWith({
      orbId: orb.id,
      url: "https://github.com/o/attached",
      signal: context.signal,
    });
  }
});

it("publishes content-free warnings and heals duplicate ready metadata without Git or repeated logs", async () => {
  const { db, task, orb, snapshot, context } = await resourceTest();
  const warnings = [
    {
      path: ".pi/skills/bad/SKILL.md",
      code: "invalid_metadata" as const,
      content: "PRIVATE CONTENT",
    },
  ];
  const expected = warnings.map(({ path, code }) => ({ path, code }));
  const log = vi.spyOn(task, "log");
  const acquire = vi.fn(() => okAsync({ ...snapshot, warnings }));
  const gate = new PgResourceGate(db, { acquire });
  {
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(
      (await db.query("SELECT resource_warnings FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap()
        .rows[0]?.resource_warnings,
    ).toEqual(expected);
    const event = (
      await db.query(
        "SELECT warnings,error_message FROM orb_resource_events WHERE orb_id=$1 AND phase='ready'",
        [orb.id],
      )
    )._unsafeUnwrap().rows[0];
    expect(event).toEqual({ warnings: expected, error_message: null });
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("invalid_metadata");
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain(warnings[0]?.path);
    expect(log.mock.calls.map(([line]) => line).join("\n")).not.toContain("PRIVATE CONTENT");
    const logged = log.mock.calls.length;
    (
      await db.query("UPDATE orbs SET resource_warnings='[]' WHERE id=$1", [orb.id])
    )._unsafeUnwrap();
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toHaveLength(logged);
    expect(
      (await db.query("SELECT resource_warnings FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap()
        .rows[0]?.resource_warnings,
    ).toEqual(expected);
  }
});

it("repairs snapshot/status publication gaps and clears stale warnings for legacy snapshots", async () => {
  const { db, task, orb, snapshot, context } = await resourceTest();
  const acquire = vi.fn(() => errAsync(resourceError("fetch", "must not refetch")));
  const warnings = [{ path: "skills/bad/SKILL.md", code: "invalid_utf8" as const }];
  {
    (await new PgResourceSnapshots(db).put({ ...snapshot, warnings }))._unsafeUnwrap();
    const gate = new PgResourceGate(db, { acquire });
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(
      (
        await db.query(
          "SELECT warnings,file_count,byte_count FROM orb_resource_events WHERE orb_id=$1 AND phase='ready'",
          [orb.id],
        )
      )._unsafeUnwrap().rows[0],
    ).toEqual({ warnings, file_count: 0, byte_count: 0 });
    (
      await db.query(
        "UPDATE orb_resource_snapshots SET manifest=manifest - 'warnings' WHERE orb_id=$1",
        [orb.id],
      )
    )._unsafeUnwrap();
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(
      (await db.query("SELECT resource_warnings FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap()
        .rows[0]?.resource_warnings,
    ).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  }
});

it.each([
  "UPDATE orbs SET agent_admission_version=agent_admission_version+1 WHERE id=$1",
  "UPDATE orbs SET stop_reason='manual' WHERE id=$1",
  "UPDATE orbs SET stop_reason='sleep' WHERE id=$1",
  "UPDATE orbs SET state='archiving' WHERE id=$1",
  "UPDATE orbs SET state='archived' WHERE id=$1",
  "UPDATE orbs SET state='deleting' WHERE id=$1",
])("fences cached ready publication: %s", async (revoke) => {
  const { db, task, orb, snapshot, context } = await resourceTest();
  const acquire = vi.fn(() => okAsync(snapshot));
  (
    await new PgResourceSnapshots(db).put({
      ...snapshot,
      warnings: [{ path: "bad", code: "invalid_yaml" }],
    })
  )._unsafeUnwrap();
  (await db.query(revoke, [orb.id]))._unsafeUnwrap();
  expect((await new PgResourceGate(db, { acquire }).acquire(task, orb, context)).isErr()).toBe(
    true,
  );
  expect(
    (await db.query("SELECT resource_warnings FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap()
      .rows[0]?.resource_warnings,
  ).toEqual([]);
  expect(
    (
      await db.query("SELECT count(*) AS n FROM orb_resource_events WHERE orb_id=$1", [orb.id])
    )._unsafeUnwrap().rows[0]?.n,
  ).toBe(0);
  expect(acquire).not.toHaveBeenCalled();
});

it("persists safe failure details and restores their code/message without changing retry semantics", async () => {
  const { db, task, orb, context } = await resourceTest();
  const failure = resourceError("authentication", "Repository authentication unavailable");
  const acquire = vi.fn(() => errAsync(failure));
  const gate = new PgResourceGate(db, { acquire });
  expect((await gate.acquire(task, orb, context))._unsafeUnwrapErr()).toEqual(failure);
  expect(
    (
      await db.query(
        "SELECT error_code,error_message,warnings FROM orb_resource_events WHERE orb_id=$1 AND phase='failed'",
        [orb.id],
      )
    )._unsafeUnwrap().rows[0],
  ).toEqual({ error_code: failure.code, error_message: failure.message, warnings: [] });
  expect((await gate.initialPin(task, orb))._unsafeUnwrapErr()).toEqual(failure);
  expect((await gate.acquire(task, orb, context))._unsafeUnwrapErr()).toEqual(failure);
  expect(acquire).toHaveBeenCalledTimes(1);
  (
    await db.query("UPDATE orb_resource_events SET error_message=NULL WHERE orb_id=$1", [orb.id])
  )._unsafeUnwrap();
  expect((await gate.initialPin(task, orb))._unsafeUnwrapErr()).toEqual(
    resourceError("authentication", "Resource acquisition failed"),
  );
  (
    await db.query("UPDATE orb_resource_events SET error_code='storage' WHERE orb_id=$1", [orb.id])
  )._unsafeUnwrap();
  expect((await gate.initialPin(task, orb))._unsafeUnwrap()).toBeNull();
});

it("rolls back ready warnings when event publication fails", async () => {
  const { db, task, orb, snapshot, context } = await resourceTest();
  {
    (
      await new PgResourceSnapshots(db).put({
        ...snapshot,
        warnings: [{ path: "bad", code: "invalid_yaml" }],
      })
    )._unsafeUnwrap();
    (
      await db.query(
        "ALTER TABLE orb_resource_events ADD CONSTRAINT reject_ready CHECK (phase <> 'ready')",
      )
    )._unsafeUnwrap();
    (
      await db.query("UPDATE orbs SET resource_warnings=$2 WHERE id=$1", [
        orb.id,
        jsonParam([{ path: "old", code: "duplicate_name" }]),
      ])
    )._unsafeUnwrap();
    const gate = new PgResourceGate(db, { acquire: () => okAsync(snapshot) });
    expect((await gate.acquire(task, orb, context)).isErr()).toBe(true);
    expect(
      (await db.query("SELECT resource_warnings FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap()
        .rows[0]?.resource_warnings,
    ).toEqual([{ path: "old", code: "duplicate_name" }]);
  }
});
