import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgentPlane } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("unloads idle stopped-host state without losing the conversation identity or admitting a stale epoch", async () => {
  let orb = makeOrbRow("orb", "project", "running");
  let opens = 0;
  const persistence = new MemoryAgentPersistence();
  const plane = (
    await DurableAgentPlane.create({
      persistence,
      currentOrb: () => okAsync(orb),
      openContext: () => {
        opens++;
        return okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: null,
          instructions: "CP",
        });
      },
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("stable-plane", false);
  const context = { signal: new AbortController().signal };
  try {
    (await plane.health(task, orb, context))._unsafeUnwrap();
    const handle = plane.session(orb.id)!;
    expect(handle.snapshot()._unsafeUnwrap().session.id).toBe(`conversation:${orb.id}`);
    const recordCount = handle.snapshot()._unsafeUnwrap().records.length;
    expect(recordCount).toBeGreaterThan(0);
    let invalidations = 0;
    const detach = handle.subscribe(
      () => undefined,
      () => {
        invalidations++;
      },
    );
    orb = { ...orb, state: "stopped", stopReason: "idle" };
    expect((await plane.unload(task, orb, context))._unsafeUnwrap()).toBe(true);
    expect(plane.session(orb.id)).toBe(handle);
    expect(handle.snapshot()._unsafeUnwrap().records).toEqual([]);
    expect(invalidations).toBe(0);
    const passive = (await plane.readSession(task, orb, context))._unsafeUnwrap();
    expect(passive).toBe(handle);
    expect((await passive.readSnapshot!())._unsafeUnwrap().records.length).toBe(recordCount);
    expect(opens).toBe(1);
    orb = { ...orb, state: "starting", agentAdmissionVersion: 1 };
    (await plane.health(task, orb, context))._unsafeUnwrap();
    expect(plane.session(orb.id)).toBe(handle);
    expect(opens).toBe(2);
    detach();
  } finally {
    await plane.close();
  }
});
