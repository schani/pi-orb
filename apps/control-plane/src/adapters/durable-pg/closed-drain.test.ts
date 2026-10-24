import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTool, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import { reconcileOrbOnce, requestOrbDeletion } from "../../domain/lifecycle.ts";
import { registerRoutes } from "../../http/routes.ts";
import {
  makeHarness,
  makeProjectRow,
  seedRunningOrb,
  TEST_SYSTEM_VIEW,
} from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { DurableAgentPlane, durableError } from "../durable/manager.ts";
import type { PgQueryResult, PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgDurableAuthority } from "./index.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An explicit schedule cut after SQL COMMIT, before in-memory drain activation. */
function drainCheckpoint(db: PostgreSQLClient, afterCommit: () => Promise<void>): PostgreSQLClient {
  return {
    query: db.query.bind(db),
    end: db.end.bind(db),
    transaction<T, E>(
      f: (
        query: (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
        execute: (text: string) => ResultAsync<void, StoreError>,
      ) => Promise<Result<T, E>>,
    ) {
      let draining = false;
      return db
        .transaction<T, E>((query, execute) =>
          f((text, values) => {
            if (text.includes("'draining'")) draining = true;
            return query(text, values);
          }, execute),
        )
        .andThen((value) =>
          ResultAsync.fromSafePromise(
            (async () => {
              if (draining) await afterCommit();
              return value;
            })(),
          ),
        );
    },
  };
}

it.each(["before", "after_commit", "foreign", "revoked", "expired", "unavailable"] as const)(
  "closed native storage preserves drain fences: %s",
  async (schedule) => {
    const db = new PGliteClient();
    let storage: Storage | undefined;
    let unavailable = false;
    const checkpoint = drainCheckpoint(db, async () => {
      if (schedule === "after_commit") await storage?.close(ctx);
    });
    const client: PostgreSQLClient = {
      ...checkpoint,
      transaction: (f) =>
        unavailable
          ? errAsync({
              type: "store_error",
              code: "unavailable",
              message: "injected outage",
              retryable: true,
            })
          : checkpoint.transaction(f),
    };
    try {
      (
        await db.query(
          "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
        )
      )._unsafeUnwrap();
      const id = randomUUID();
      (await db.query("INSERT INTO orbs(id) VALUES($1)", [id]))._unsafeUnwrap();
      const migration = await readFile(
        new URL("../pg/migrations/036_durable_authority.sql", import.meta.url),
        "utf8",
      );
      (await db.transaction(async (_q, execute) => execute(migration)))._unsafeUnwrap();
      let now = 0;
      const authority = new PgDurableAuthority(client, () => now);
      const owner = (await authority.acquire(id, "owner", 0, 0, 100))._unsafeUnwrap();
      storage = (
        await authority.open(owner, { project: async () => okAsync(undefined) })
      )._unsafeUnwrap();
      if (schedule !== "after_commit") await storage.close(ctx);
      if (schedule === "revoked") (await authority.release(owner))._unsafeUnwrap();
      if (schedule === "expired") now = 100;
      unavailable = schedule === "unavailable";
      const result = await authority.beginDrain(
        schedule === "foreign" ? { ...owner, ownerId: "foreign" } : owner,
        storage,
      );
      if (schedule === "before" || schedule === "after_commit") {
        expect(result.isOk(), JSON.stringify(result)).toBe(true);
        await expect(storage.commit([], ctx)).rejects.toThrow(/closed/i);
        expect((await authority.validate(owner)).isOk()).toBe(true);
      } else if (schedule === "revoked" || schedule === "expired") {
        expect(result._unsafeUnwrap()).toMatchObject({
          type: "owner_lost",
          cause: { type: "authority_error", code: "stale_owner" },
        });
      } else {
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().code).toBe(
          schedule === "unavailable" ? "unavailable" : "stale_owner",
        );
      }
    } finally {
      await storage?.close(ctx);
      (await db.end())._unsafeUnwrap();
    }
  },
);

it.each([false, true])(
  "native failure disposal joins resources and preserves cleanup failure=%s",
  async (cleanupFails) => {
    const db = new PGliteClient();
    const entered = barrier(),
      releaseTool = barrier(),
      resourcesEntered = barrier(),
      releaseResources = barrier();
    const failed = barrier(),
      suspended = barrier();
    let storage: Storage | undefined;
    const database = composeControlPlaneDatabase(
      drainCheckpoint(db, async () => {
        await storage?.close(ctx);
      }),
    );
    const task = new NoSimulationTask("native failure deletion", false);
    const h = makeHarness({ constants: { deletionQuarantineMs: 0 } });
    const id = randomUUID(),
      project = makeProjectRow(randomUUID());
    seedRunningOrb(task, h, id);
    const seeded = h.store.orbSnapshot(id);
    if (seeded === null) throw new Error("fixture orb missing");
    const orb = { ...seeded, projectId: project.id };
    const model = fauxProvider();
    model.setResponses([fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(model.provider);
    const registry = createRegistry();
    registry.install({
      name: "held",
      tools: [
        defineTool({
          name: "held",
          description: "Held native tool",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            entered.resolve();
            await releaseTool.promise;
            return { output: [{ type: "text", text: "completed" }] };
          },
        }),
      ],
    });
    const plane = (
      await DurableAgentPlane.create({
        persistence: database.agentPersistence,
        openContext: (_task, _orb, _context, _readOnly, lease) => {
          storage = lease?.storage;
          return okAsync({
            models,
            registry,
            env: new NodeExecutionEnv({ cwd: "/tmp" }),
            instructions: "",
            checkoutCommit: "commit",
            initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
            closeResources: () => {
              resourcesEntered.resolve();
              return ResultAsync.fromSafePromise(releaseResources.promise).andThen(() =>
                cleanupFails
                  ? errAsync(durableError("execution cleanup failed"))
                  : okAsync(undefined),
              );
            },
            edge: (code) => {
              if (code === "harness.storage_failed") failed.resolve();
              if (code === "harness.suspended" || code === "harness.resources_close_failed")
                suspended.resolve();
              return okAsync(undefined);
            },
          });
        },
      })
    )._unsafeUnwrap();
    const deps = { ...h.deps, store: database.store, agentPlane: plane };
    const app = Fastify();
    registerRoutes(app, task, deps, {}, TEST_SYSTEM_VIEW);
    try {
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
      const context = { signal: new AbortController().signal };
      (await plane.health(task, orb, context))._unsafeUnwrap();
      const messageId = randomUUID();
      const content = [{ type: "text" as const, text: "run" }];
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: id,
          messageId,
          content,
          wake: false,
          now: task.wallNow(),
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: id, now: task.wallNow() })
      )._unsafeUnwrap();
      const delivery = await plane.deliverMessage(
        task,
        orb,
        { baseUrl: "central", messageId, messageIds: [messageId], content },
        context,
      );
      expect(delivery.isOk(), JSON.stringify(delivery)).toBe(true);
      await entered.promise;
      (await requestOrbDeletion(task, deps, id))._unsafeUnwrap();
      releaseTool.resolve();
      await failed.promise;
      await resourcesEntered.promise;
      const disposalEntered = barrier();
      const dispose = plane.dispose.bind(plane);
      vi.spyOn(plane, "dispose").mockImplementationOnce((...args) => {
        const result = dispose(...args);
        disposalEntered.resolve();
        return result;
      });
      let reconciled = false;
      const reconciliation = reconcileOrbOnce(task, deps, id).then((result) => {
        reconciled = true;
        return result;
      });
      await disposalEntered.promise;
      expect(h.world.hostCount(id)).toBe(1);
      expect(reconciled).toBe(false);
      expect((await app.inject({ method: "GET", url: `/api/v1/orbs/${id}` })).statusCode).toBe(200);
      releaseResources.resolve();
      await suspended.promise;
      await reconciliation;
      const retried = await plane.dispose(task, id, true, context);
      if (cleanupFails) {
        expect(retried._unsafeUnwrapErr().message).toBe("execution cleanup failed");
        expect(h.world.hostCount(id)).toBe(1);
        expect((await app.inject({ method: "GET", url: `/api/v1/orbs/${id}` })).statusCode).toBe(
          200,
        );
        return;
      }
      expect(retried.isOk(), JSON.stringify(retried)).toBe(true);
      await reconcileOrbOnce(task, deps, id);
      expect(plane.session(id)).toBeNull();
      expect(h.world.hostCount(id)).toBe(0);
      expect((await app.inject({ method: "GET", url: `/api/v1/orbs/${id}` })).statusCode).toBe(404);
    } finally {
      releaseTool.resolve();
      releaseResources.resolve();
      await plane.close();
      await app.close();
      (await database.close())._unsafeUnwrap();
    }
  },
);
