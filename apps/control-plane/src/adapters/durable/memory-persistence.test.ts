import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("classifies memory drain without renewing or synchronously aborting ownership", async () => {
  let now = 0;
  const persistence = new MemoryAgentPersistence(() => now, 100);
  const task = new NoSimulationTask("memory-drain", false);
  const orb = makeOrbRow("orb", makeProjectRow("project").id, "running");
  const context = { signal: new AbortController().signal };
  const lease = (await persistence.open(task, orb, context))._unsafeUnwrap();
  expect((await lease.beginDrain())._unsafeUnwrap()).toBeUndefined();
  now = 100;
  expect((await lease.beginDrain())._unsafeUnwrap()).toMatchObject({ type: "owner_lost" });
  expect(lease.signal.aborted).toBe(false);
  const next = (await persistence.open(task, orb, context))._unsafeUnwrap();
  expect((await lease.beginDrain())._unsafeUnwrap()).toMatchObject({ type: "owner_lost" });
  expect((await next.beginDrain())._unsafeUnwrap()).toBeUndefined();
  persistence.revoke(orb.id);
  expect((await next.beginDrain())._unsafeUnwrap()).toMatchObject({ type: "owner_lost" });
  (await persistence.close())._unsafeUnwrap();
});
