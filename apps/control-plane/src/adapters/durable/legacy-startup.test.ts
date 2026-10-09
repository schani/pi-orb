import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { registerAuthenticatedBrowserRoutes } from "../../http/browser-identity.ts";
import { registerRoutes } from "../../http/routes.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { DurableAgentPlane } from "./manager.ts";
import { PgAgentPersistence } from "./pg-persistence.ts";

const message = "This orb uses the old Pi backend. Create a new orb to continue.";
const operation = { signal: new AbortController().signal };
async function fixture() {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("legacy-startup", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  (await database.migrate())._unsafeUnwrap();
  (
    await database.users.resolveUser(
      task,
      { issuer: "test", subject: "owner", email: null },
      { id: project.ownerUserId, now: 0 },
    )
  )._unsafeUnwrap();
  (await database.store.insertProject(task, project))._unsafeUnwrap();
  (await database.store.insertOrb(task, orb))._unsafeUnwrap();
  const snapshot = async () => {
    const state: unknown[] = [];
    for (const table of [
      "orbs",
      "history_records",
      "durable_pg_owners",
      "durable_pg_owner_events",
      "durable_pg_durable_metadata",
      "durable_pg_conversations",
      "durable_pg_documents",
      "durable_pg_document_revisions",
      "durable_pg_entries",
    ])
      state.push(
        (
          await db.query(`SELECT * FROM ${table} WHERE ${table === "orbs" ? "id" : "orb_id"}=$1`, [
            orb.id,
          ])
        )._unsafeUnwrap().rows,
      );
    return state;
  };
  return { db, database, task, orb, snapshot };
}

it.each(["header", "cursor", "partial", "keyed"] as const)(
  "rejects old %s session before acquiring or initializing, preserving all history",
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === "partial") {
        const authority = new PgDurableAuthority(f.db);
        const owner = (await authority.acquire(f.orb.id, "partial", 0, 0, 1000))._unsafeUnwrap();
        const storage = (
          await authority.open(owner, { project: async () => okAsync(undefined) })
        )._unsafeUnwrap();
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          context,
        );
        await harness.root(context);
        await harness.close(context);
        (await authority.release(owner))._unsafeUnwrap();
      }
      if (kind === "keyed") {
        const authority = new PgDurableAuthority(f.db);
        const owner = (await authority.acquire(f.orb.id, "keyed", 0, 0, 1000))._unsafeUnwrap();
        const storage = (
          await authority.open(owner, { project: async () => okAsync(undefined) })
        )._unsafeUnwrap();
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          context,
        );
        const root = await harness.root(context);
        const identity = defineDocFamily({
          kind: "orb.identity",
          version: 1,
          scope: "conversation",
          family: true,
          history: "latest",
          fork: "initial",
          initial: () => ({ sessionId: "host-sdk-session", timestamp: 0 }),
        });
        await root.commit(async (tx) => {
          await tx.doc(identity, root.id, "not-the-root-identity", null);
        }, context);
        await harness.close(context);
        (await authority.release(owner))._unsafeUnwrap();
      }
      (
        await f.database.store.initOrVerifySession(f.task, f.orb.id, {
          id: "host-sdk-session",
          overflow: {},
        })
      )._unsafeUnwrap();
      if (kind === "cursor")
        (
          await f.database.store.commitPullBatch(f.task, {
            orbId: f.orb.id,
            expectedCursor: null,
            session: { id: "host-sdk-session", overflow: {} },
            records: [
              {
                id: "old-record",
                parentId: null,
                timestamp: new Date(0).toISOString(),
                overflow: {},
                type: "message",
                role: "user",
                content: [{ type: "text", text: "old history" }],
              },
            ],
            nextCursor: "old-record",
            nextHeadId: "old-record",
          })
        )._unsafeUnwrap();
      const before = await f.snapshot();
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.database.agentPersistence.open(f.task, f.orb, operation);
        if (result.isOk()) await result.value.release();
        expect(result.isErr() ? result.error : null).toMatchObject({
          code: "legacy_backend",
          retryable: false,
          message,
        });
        expect(await f.snapshot()).toEqual(before);
      }
      const passive = (await f.database.agentPersistence.snapshot(f.task, f.orb))._unsafeUnwrap();
      expect(passive.session.id).toBe("host-sdk-session");
    } finally {
      await f.database.agentPersistence.close();
      await f.database.close();
    }
  },
);

it("permits fresh central headers and valid native reopen, but rejects missing native cursor as integrity", async () => {
  const f = await fixture();
  let agent: DurableAgent | undefined;
  try {
    (
      await f.database.store.initOrVerifySession(f.task, f.orb.id, {
        id: `conversation:${f.orb.id}`,
        overflow: { harness: "pi-durable" },
      })
    )._unsafeUnwrap();
    const open = async () => {
      const lease = (
        await f.database.agentPersistence.open(f.task, f.orb, operation)
      )._unsafeUnwrap();
      return DurableAgent.open({
        orbId: f.orb.id,
        storage: lease.storage,
        models: createModels(),
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "pin",
        instructions: "test",
        resume: false,
        closeResources: lease.release,
      });
    };
    agent = (await open())._unsafeUnwrap();
    await agent.close();
    agent = (await open())._unsafeUnwrap();
    await agent.close();
    agent = undefined;
    const published = (
      await f.database.store.readHistorySnapshot(f.task, f.orb.id)
    )._unsafeUnwrap();
    (
      await f.database.store.commitPullBatch(f.task, {
        orbId: f.orb.id,
        expectedCursor: published.cursor,
        session: published.session!,
        records: [
          {
            id: "missing",
            parentId: published.headId,
            timestamp: new Date(0).toISOString(),
            overflow: {},
            type: "message",
            role: "user",
            content: [{ type: "text", text: "absent from native" }],
          },
        ],
        nextCursor: "missing",
        nextHeadId: "missing",
      })
    )._unsafeUnwrap();
    const before = await f.snapshot();
    const result = await f.database.agentPersistence.open(f.task, f.orb, operation);
    if (result.isOk()) await result.value.release();
    expect(result.isErr() ? result.error : null).toMatchObject({
      code: "history_integrity",
      retryable: false,
    });
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await agent?.close();
    await f.database.agentPersistence.close();
    await f.database.close();
  }
});

it("preserves the typed terminal rejection through the real SDK when legacy publication follows lease acquisition", async () => {
  const f = await fixture();
  try {
    const lease = (
      await f.database.agentPersistence.open(f.task, f.orb, operation)
    )._unsafeUnwrap();
    (
      await f.database.store.initOrVerifySession(f.task, f.orb.id, {
        id: "host-sdk-session",
        overflow: {},
      })
    )._unsafeUnwrap();
    const before = await f.snapshot();
    const result = await DurableAgent.open({
      orbId: f.orb.id,
      storage: lease.storage,
      models: createModels(),
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "pin",
      instructions: "test",
      resume: false,
      closeResources: lease.release,
    });
    if (result.isOk()) await result.value.close();
    expect(result.isErr() ? result.error : null).toMatchObject({
      code: "legacy_backend",
      retryable: false,
      message,
    });
    const after = await f.snapshot();
    // Cleanup releases the lease; no public data, identity/settings or allocated IDs change.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after.slice(4)).toEqual(before.slice(4));
  } finally {
    await f.database.agentPersistence.close();
    await f.database.close();
  }
});

it.each(["archived", "archiving", "deleting"] as const)(
  "does not create private authority for %s without an owner row",
  async (state) => {
    const f = await fixture();
    try {
      (await f.db.query("UPDATE orbs SET state=$2 WHERE id=$1", [f.orb.id, state]))._unsafeUnwrap();
      const before = await f.snapshot();
      const result = await f.database.agentPersistence.open(f.task, f.orb, operation);
      if (result.isOk()) await result.value.release();
      expect(result.isErr()).toBe(true);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.database.agentPersistence.close();
      await f.database.close();
    }
  },
);

it.each(["malformed", "header-conflict", "head-without-cursor", "custom-session"] as const)(
  "validates current Native %s evidence without rewriting it",
  async (kind) => {
    const f = await fixture();
    try {
      const authority = new PgDurableAuthority(f.db);
      const owner = (await authority.acquire(f.orb.id, "seed", 0, 0, 1000))._unsafeUnwrap();
      const storage = (
        await authority.open(owner, { project: async () => okAsync(undefined) })
      )._unsafeUnwrap();
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        context,
      );
      const root = await harness.root(context);
      const identity = defineDoc({
        kind: "orb.identity",
        version: 1,
        scope: "conversation",
        history: "latest",
        fork: "initial",
        initial: () => ({
          sessionId: "actual-native-session",
          timestamp: kind === "malformed" ? "bad" : 0,
        }),
      });
      await root.commit(async (tx) => {
        await tx.doc(identity, root.id);
      }, context);
      await harness.close(context);
      (await authority.release(owner))._unsafeUnwrap();
      (
        await f.database.store.initOrVerifySession(f.task, f.orb.id, {
          id: "actual-native-session",
          overflow: {},
        })
      )._unsafeUnwrap();
      if (kind === "header-conflict") {
        const before = await f.snapshot();
        expect(
          (
            await f.db.query("UPDATE orbs SET harness_session_header=$2::jsonb WHERE id=$1", [
              f.orb.id,
              JSON.stringify({ id: "conflicting-header" }),
            ])
          ).isErr(),
        ).toBe(true);
        expect(await f.snapshot()).toEqual(before);
        return;
      }
      if (kind === "head-without-cursor") {
        (
          await f.database.store.commitPullBatch(f.task, {
            orbId: f.orb.id,
            expectedCursor: null,
            session: { id: "actual-native-session", overflow: {} },
            records: [
              {
                id: "unknown",
                parentId: null,
                timestamp: new Date(0).toISOString(),
                overflow: {},
                type: "message",
                role: "user",
                content: [{ type: "text", text: "not native" }],
              },
            ],
            nextCursor: "unknown",
            nextHeadId: "unknown",
          })
        )._unsafeUnwrap();
        (
          await f.db.query("UPDATE orbs SET replication_cursor=NULL WHERE id=$1", [f.orb.id])
        )._unsafeUnwrap();
      }
      const before = await f.snapshot();
      const check = await f.database.agentPersistence.checkStartup!(f.task, f.orb, operation);
      if (kind === "custom-session") expect(check.isOk()).toBe(true);
      else
        expect(check.isErr() ? check.error : null).toMatchObject({
          code: "history_integrity",
          retryable: false,
        });
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.database.agentPersistence.close();
      await f.database.close();
    }
  },
);

it.each(["archiving", "deleting"] as const)(
  "permits already-owned Native cleanup while %s without reopening startup",
  async (state) => {
    const f = await fixture();
    const lease = (
      await f.database.agentPersistence.open(f.task, f.orb, operation)
    )._unsafeUnwrap();
    const harness = await Harness.open(
      lease.storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    try {
      const root = await harness.root(context);
      const progress = defineDoc({
        kind: "orb.private-progress",
        version: 1,
        scope: "conversation",
        history: "latest",
        fork: "initial",
        initial: () => ({ ticks: 0 }),
      });
      await root.commit(async (tx) => {
        await tx.doc(progress, root.id);
      }, context);
      (
        await f.db.query(
          "UPDATE orbs SET state=$2,agent_admission_version=agent_admission_version+1 WHERE id=$1",
          [f.orb.id, state],
        )
      )._unsafeUnwrap();
      (await lease.beginDrain())._unsafeUnwrap();
      const publicBefore = (await f.snapshot()).slice(0, 2);
      await expect(
        root.commit(async (tx) => {
          (await tx.doc(progress, root.id)).ticks++;
        }, context),
      ).resolves.toBeUndefined();
      expect((await f.snapshot()).slice(0, 2)).toEqual(publicBefore);
      const current = (await f.database.store.getOrb(f.task, f.orb.id))._unsafeUnwrap()!;
      const opening = await f.database.agentPersistence.open(f.task, current, operation);
      if (opening.isOk()) await opening.value.release();
      expect(opening.isErr()).toBe(true);
      (
        await f.db.query("UPDATE orbs SET state='archived' WHERE id=$1", [f.orb.id])
      )._unsafeUnwrap();
      const sealed = await f.snapshot();
      await expect(
        root.commit(async (tx) => {
          (await tx.doc(progress, root.id)).ticks++;
        }, context),
      ).rejects.toMatchObject({ cause: { type: "authority_error", code: "closed" } });
      expect(await f.snapshot()).toEqual(sealed);
    } finally {
      await harness.close(context);
      await lease.release();
      await f.database.agentPersistence.close();
      await f.database.close();
    }
  },
);

it("keeps Native-read outages retryable instead of terminalizing history", async () => {
  const f = await fixture();
  let failReads = false;
  const faulty = new Proxy(f.db, {
    get(target, key) {
      if (key === "transaction")
        return (...args: Parameters<PostgreSQLClient["transaction"]>) =>
          target.transaction((query, execute) =>
            args[0](
              (sql, values) =>
                failReads && sql.includes("durable_pg_document_revisions")
                  ? errAsync({
                      type: "store_error" as const,
                      code: "unavailable" as const,
                      retryable: true,
                      message: "injected outage",
                    })
                  : query(sql, values),
              execute,
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PostgreSQLClient;
  const persistence = new PgAgentPersistence(faulty, f.database.store);
  try {
    const lease = (
      await f.database.agentPersistence.open(f.task, f.orb, operation)
    )._unsafeUnwrap();
    const agent = (
      await DurableAgent.open({
        orbId: f.orb.id,
        storage: lease.storage,
        models: createModels(),
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "pin",
        instructions: "test",
        resume: false,
        closeResources: lease.release,
      })
    )._unsafeUnwrap();
    await agent.close();
    const before = await f.snapshot();
    failReads = true;
    const check = await persistence.checkStartup(f.task, f.orb, operation);
    expect(check.isErr() ? check.error : null).toMatchObject({
      code: "history_unavailable",
      retryable: true,
    });
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await persistence.close();
    await f.database.agentPersistence.close();
    await f.database.close();
  }
});

it("preserves SDK terminal startup failure even when lease cleanup fails", async () => {
  const f = await fixture();
  const log = vi.spyOn(f.task, "log");
  const plane = (
    await DurableAgentPlane.create({
      persistence: {
        checkStartup: (...args) => f.database.agentPersistence.checkStartup!(...args),
        open: (...args) =>
          f.database.agentPersistence.open(...args).andThen((lease) =>
            f.database.store
              .initOrVerifySession(f.task, f.orb.id, { id: "host-sdk-session", overflow: {} })
              .mapErr(() => ({
                type: "runtime_client_error" as const,
                code: "history_unavailable" as const,
                answered: true,
                retryable: true,
                message: "publish failed",
              }))
              .map(() => ({
                ...lease,
                release: () =>
                  lease.release().andThen(() =>
                    errAsync({
                      type: "runtime_client_error" as const,
                      code: "history_unavailable" as const,
                      answered: true,
                      retryable: true,
                      message: "injected cleanup failure",
                    }),
                  ),
              })),
          ),
        snapshot: (...args) => f.database.agentPersistence.snapshot(...args),
        dispose: (...args) => f.database.agentPersistence.dispose(...args),
        close: () => f.database.agentPersistence.close(),
      },
      openContext: () =>
        okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "pin",
          instructions: "test",
          resume: false,
        }),
    })
  )._unsafeUnwrap();
  try {
    const result = await plane.health(f.task, f.orb, operation);
    expect(result.isErr() ? result.error : null).toMatchObject({
      code: "legacy_backend",
      retryable: false,
      message,
    });
    expect(
      log.mock.calls.filter(([line]) => String(line).includes("agent.startup_cleanup_failed")),
    ).toHaveLength(1);
  } finally {
    await plane.close();
    await f.database.close();
  }
});

it("returns the terminal Start error through authenticated HTTP backed by actual Native persistence", async () => {
  const f = await fixture();
  let preparations = 0;
  const plane = (
    await DurableAgentPlane.create({
      persistence: f.database.agentPersistence,
      openContext: () => {
        preparations++;
        return okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "pin",
          instructions: "test",
        });
      },
    })
  )._unsafeUnwrap();
  const h = makeHarness();
  const app = Fastify();
  registerAuthenticatedBrowserRoutes(
    app,
    () => okAsync({ kind: "user" as const, user: { id: TEST_USER_ID, email: null } }),
    (browser) =>
      registerRoutes(
        browser,
        f.task,
        { ...h.deps, store: f.database.store, agentPlane: plane },
        {},
        TEST_SYSTEM_VIEW,
      ),
  );
  try {
    (
      await f.database.store.initOrVerifySession(f.task, f.orb.id, {
        id: "host-sdk-session",
        overflow: {},
      })
    )._unsafeUnwrap();
    const before = await f.snapshot();
    const response = await app.inject({ method: "POST", url: `/api/v1/orbs/${f.orb.id}/start` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "conflict", message, retryable: false } });
    expect(await f.snapshot()).toEqual(before);
    expect(preparations).toBe(0);
  } finally {
    await app.close();
    await plane.close();
    await f.database.close();
  }
});

it("does not prepare resources for rejected startup or passive history and terminalizes absent-agent delivery", async () => {
  const f = await fixture();
  let preparations = 0;
  const plane = (
    await DurableAgentPlane.create({
      persistence: f.database.agentPersistence,
      prepare: () => {
        preparations++;
        return okAsync(undefined);
      },
      openContext: () => {
        preparations++;
        return okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "pin",
          instructions: "test",
        });
      },
    })
  )._unsafeUnwrap();
  try {
    (
      await f.database.store.initOrVerifySession(f.task, f.orb.id, {
        id: "host-sdk-session",
        overflow: {},
      })
    )._unsafeUnwrap();
    const handle = (await plane.readSession(f.task, f.orb, operation))._unsafeUnwrap();
    expect((await handle.readSnapshot!())._unsafeUnwrap().session.id).toBe("host-sdk-session");
    const health = await plane.health(f.task, f.orb, operation);
    expect(health.isErr() ? health.error : null).toMatchObject({
      code: "legacy_backend",
      retryable: false,
    });
    const delivery = await plane.deliverMessage(
      f.task,
      f.orb,
      {
        baseUrl: "unused",
        messageId: "input",
        messageIds: ["input"],
        content: [{ type: "text", text: "continue" }],
      },
      operation,
    );
    expect(delivery.isErr() ? delivery.error : null).toMatchObject({
      code: "legacy_backend",
      retryable: false,
      message,
    });
    expect(preparations).toBe(0);
  } finally {
    await plane.close();
    await f.database.close();
  }
});
