import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import {
  enqueueOrbMessage,
  reconcileCentralAgent,
  reconcileOrbOnce,
} from "../../domain/lifecycle.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { DurableAgentPlane } from "../durable/manager.ts";
import { PGliteClient } from "./pglite-client.ts";

it("migrates legacy manual intent and keeps reopened work and visible compute paused until fresh input", async () => {
  const task = new NoSimulationTask("manual intent migration", false);
  const client = new PGliteClient();
  const database = composeControlPlaneDatabase(client);
  let plane: DurableAgentPlane | undefined;
  let effects = 0;
  let inferences = 0;
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(
    [0, 1].map(() => () => {
      inferences++;
      return fauxAssistantMessage("fresh inference");
    }),
  );
  const pending = defineTask<null, { phase: "run" }, null>({
    name: "legacy-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        effects++;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = () => {
    const value = createRegistry();
    value.install({ name: "legacy-work", tasks: [pending] });
    return value;
  };
  const project = makeProjectRow("00000000-0000-4000-8000-000000000051");
  const states = ["stopped", "stopping", "stopped", "stopping", "failed", "running"] as const;
  const reasons = [null, null, "idle", "sleep", null, null] as const;
  const rows = states.map((state, index) =>
    makeOrbRow(`00000000-0000-4000-8000-00000000006${index}`, project.id, state, {
      stopReason: reasons[index] ?? null,
    }),
  );
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    for (const row of rows) (await database.store.insertOrb(task, row))._unsafeUnwrap();
    // Restore the actual pre-feature schema and explicit Stop's null encoding.
    for (const sql of [
      "ALTER TABLE orbs DROP COLUMN agent_admission_version",
      "ALTER TABLE orbs DROP CONSTRAINT orbs_stop_reason_check",
      "ALTER TABLE orbs ADD CONSTRAINT orbs_stop_reason_check CHECK (stop_reason IN ('idle', 'sleep'))",
      "DELETE FROM schema_migrations WHERE name IN ('033_manual_stop.sql', '034_agent_admission_version.sql')",
    ])
      (await client.query(sql))._unsafeUnwrap();
    expect((await database.migrate())._unsafeUnwrap()).toEqual([
      "033_manual_stop.sql",
      "034_agent_admission_version.sql",
    ]);
    for (const [index, row] of rows.entries()) {
      expect((await database.store.getOrb(task, row.id))._unsafeUnwrap()?.stopReason).toBe(
        index < 2 ? "manual" : reasons[index],
      );
    }
    for (const row of rows.slice(0, 2)) {
      const migrated = (await database.store.getOrb(task, row.id))._unsafeUnwrap()!;
      const acquired = await database.agentPersistence.open(task, migrated, {
        signal: new AbortController().signal,
      });
      expect(acquired.isOk(), acquired.isErr() ? acquired.error.message : "acquired").toBe(true);
      const lease = acquired._unsafeUnwrap();
      const storage = lease.storage;
      const harness = await Harness.open(
        storage,
        { models, registry: registry() },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      await root.commit(
        (tx) => tx.createTask(pending, null, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      );
      await harness.close(BACKGROUND_CONTEXT);
      (await lease.release())._unsafeUnwrap();
    }
    plane = (
      await DurableAgentPlane.create({
        persistence: database.agentPersistence,
        openContext: (_task, orb) =>
          okAsync({
            models,
            registry: registry(),
            env: new NodeExecutionEnv({ cwd: "/tmp" }),
            instructions: "CP",
            checkoutCommit: null,
            initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
            resume: orb.stopReason !== "manual" && orb.stopReason !== "sleep",
          }),
      })
    )._unsafeUnwrap();
    const h = makeHarness();
    const deps = { ...h.deps, store: database.store, agentPlane: plane };
    const context = { signal: new AbortController().signal };
    for (const [index, row] of rows.slice(0, 2).entries()) {
      const migrated = (await database.store.getOrb(task, row.id))._unsafeUnwrap()!;
      const health = await plane.health(task, migrated, context);
      expect(health.isOk(), JSON.stringify(health)).toBe(true);
      expect(plane.session(row.id)?.snapshot()._unsafeUnwrap().settings?.writable).toBe(false);
      expect(plane.session(row.id)?.workActive?.()).toBe(false);
      deps.control.registerBrowserConnection(row.id, "visible");
      deps.control.setBrowserVisibility(row.id, "visible", true, task.wallNow());
      for (let pass = 0; pass < 3; pass++) {
        await reconcileCentralAgent(task, deps, row.id);
        await reconcileOrbOnce(task, deps, row.id);
      }
      expect((await database.store.getOrb(task, row.id))._unsafeUnwrap()).toMatchObject({
        state: "stopped",
        stopReason: "manual",
      });
      expect(h.world.hostCount(row.id)).toBe(0);
      expect(effects).toBe(index);
      expect(inferences).toBe(index);
      (
        await enqueueOrbMessage(task, deps, {
          orbId: row.id,
          messageId: `00000000-0000-4000-8000-00000000007${index}`,
          content: [{ type: "text", text: "fresh input" }],
        })
      )._unsafeUnwrap();
      expect((await database.store.getOrb(task, row.id))._unsafeUnwrap()).toMatchObject({
        stopReason: null,
        agentAdmissionVersion: 1,
      });
      (await reconcileCentralAgent(task, deps, row.id))._unsafeUnwrap();
      await vi.waitFor(() => {
        expect(effects).toBe(index + 1);
        expect(inferences).toBe(index + 1);
      });
    }
  } finally {
    await plane?.close();
    await database.close();
  }
});
