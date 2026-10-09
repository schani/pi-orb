import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineTask, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { reconcileOrbOnce, requestOrbArchive } from "../../domain/lifecycle.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { DurableAgentPlane } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("reads authoritative archive history after suspension without resuming retained work", async () => {
  const path = await mkdtemp(join(tmpdir(), "durable-archive-reader-"));
  let effects = 0;
  const openModes: unknown[] = [];
  const pending = defineTask<null, { phase: "run" }, null>({
    name: "archive-work",
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
    value.install({ name: "archive-work", tasks: [pending] });
    return value;
  };
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: registry() },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "openai-codex", modelId: "gpt-6.1" } },
  });
  const identity = defineDoc({
    kind: "orb.identity",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ sessionId: "archive-session", timestamp: 0, receipts: {} }),
  });
  await root.commit(async (tx) => {
    await tx.doc(identity, root.id);
    await tx.appendEntry(root.id, {
      kind: "orb.alert",
      data: { requestId: "seed", message: "retained archive history", timestamp: Date.now() },
    });
    return tx.createTask(pending, null, { ownership: { kind: "conversation" } });
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  await authority.close();
  const plane = (
    await DurableAgentPlane.create({
      persistence: authority,
      openContext: () =>
        okAsync({
          models: createModels(),
          registry: registry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          instructions: "CP",
          checkoutCommit: null,
          resume: true,
          edge: (name, facts) => {
            if (name === "harness.opened") openModes.push(facts["readonly"]);
            return okAsync(undefined);
          },
        }),
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("sealed archive reader", false);
  const context = { signal: new AbortController().signal };
  const orb = makeOrbRow("orb", "project", "archiving");
  try {
    (await plane.suspend(task, orb.id, context, orb.agentAdmissionVersion))._unsafeUnwrap();
    const pulled = await plane.pullHistory(
      task,
      orb,
      { baseUrl: "central", after: null, limit: 500 },
      context,
    );
    expect(pulled.isOk(), pulled.isErr() ? pulled.error.message : "").toBe(true);
    expect(pulled._unsafeUnwrap().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alert: expect.objectContaining({ message: "retained archive history" }),
        }),
      ]),
    );
    expect(openModes).toEqual([]); // Passive history never composes an agent.
    expect(effects).toBe(0);
    expect(plane.session(orb.id)).toBeNull();
    expect(
      (await plane.appendAlert(orb.id, "late", "late", orb.agentAdmissionVersion)).isErr(),
    ).toBe(true);
    (await plane.suspend(task, orb.id, context, orb.agentAdmissionVersion))._unsafeUnwrap();
    expect(plane.session(orb.id)).toBeNull();
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "stopped", { stopReason: "manual" }));
    const deps = { ...h.deps, agentPlane: plane };
    deps.control.noteAgentWork(orb.id, true);
    (await requestOrbArchive(task, deps, orb.id))._unsafeUnwrap();
    await reconcileOrbOnce(task, deps, orb.id);
    expect((await h.store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toMatchObject({
      historySealedAt: expect.any(Number),
    });
    expect(plane.session(orb.id)).toBeNull();
    expect(deps.control.hasAgentWork(orb.id)).toBe(false);
    expect(effects).toBe(0);
    expect(h.world.hostCount(orb.id)).toBe(0);
  } finally {
    await plane.close();
    await rm(path, { recursive: true, force: true });
  }
});
