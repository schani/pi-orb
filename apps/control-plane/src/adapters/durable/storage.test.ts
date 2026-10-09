import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

const task = new NoSimulationTask("memory-lease", false);
const context = { signal: new AbortController().signal };

it("retains backend identity across Harness storage-view close and persistence reopen", async () => {
  const persistence = new MemoryAgentPersistence();
  const first = (await persistence.openOrb("orb", false))._unsafeUnwrap().storage;
  const id = await first.mintId();
  await first.close(BACKGROUND_CONTEXT);
  await persistence.close();
  const second = (await persistence.openOrb("orb", true))._unsafeUnwrap().storage;
  expect(await second.mintId()).toBeGreaterThan(id);
});

it("holds one owner per orb and releases ownership without erasing authority", async () => {
  const persistence = new MemoryAgentPersistence();
  const orb = makeOrbRow("orb", "project", "running");
  const owner = (await persistence.open(task, orb, context))._unsafeUnwrap();
  expect((await persistence.open(task, orb, context)).isErr()).toBe(true);
  expect((await persistence.open(task, { ...orb, id: "other" }, context)).isOk()).toBe(true);
  expect((await owner.check()).isOk()).toBe(true);
  (await owner.release())._unsafeUnwrap();
  expect(owner.signal.aborted).toBe(true);
  expect((await owner.check()).isErr()).toBe(true);
  expect((await persistence.open(task, orb, context)).isOk()).toBe(true);
  await persistence.close();
});

it("expires the exact owner and prevents stale release from revoking its replacement", async () => {
  let now = 0;
  const persistence = new MemoryAgentPersistence(() => now, 10);
  const orb = makeOrbRow("orb", "project", "running");
  const old = (await persistence.open(task, orb, context))._unsafeUnwrap();
  now = 10;
  const fresh = (
    await persistence.open(task, { ...orb, agentAdmissionVersion: 1 }, context)
  )._unsafeUnwrap();
  expect(old.signal.aborted).toBe(true);
  expect((await old.check()).isErr()).toBe(true);
  await expect(old.storage.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("owner revoked");
  await old.release();
  expect(fresh.signal.aborted).toBe(false);
  expect((await fresh.check()).isOk()).toBe(true);
  await fresh.release();
  expect((await persistence.open(task, orb, context)).isErr()).toBe(true);
  await persistence.close();
});

it("never creates missing retained authority", async () => {
  const persistence = new MemoryAgentPersistence();
  expect((await persistence.openOrb("established", true)).isErr()).toBe(true);
});
