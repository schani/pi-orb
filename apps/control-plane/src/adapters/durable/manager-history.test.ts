import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgent } from "./agent.ts";
import { DurableAgentPlane, durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

async function loaded() {
  const persistence = new MemoryAgentPersistence();
  const plane = (
    await DurableAgentPlane.create({
      persistence,
      openContext: () =>
        okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: null,
          instructions: "",
        }),
    })
  )._unsafeUnwrap();
  onTestFinished(async () => {
    (await plane.close())._unsafeUnwrap();
  });
  const task = new NoSimulationTask("loaded history", false);
  const orb = makeOrbRow("orb", "project", "running");
  const context = { signal: new AbortController().signal };
  (await plane.health(task, orb, context))._unsafeUnwrap();
  const pull = (after: string | null, limit = 500) =>
    plane.pullHistory(task, orb, { baseUrl: "central", after, limit }, context);
  return { persistence, pull };
}

it("keeps cached reads local and pages from committed history when the cursor outruns cache", async () => {
  const h = await loaded();
  const snapshot = vi.spyOn(h.persistence, "snapshot");
  const cached = (await h.pull(null))._unsafeUnwrap();
  expect(cached.records.length).toBeGreaterThan(0);
  (await h.pull(cached.cursor))._unsafeUnwrap();
  expect(snapshot).not.toHaveBeenCalled();
  const source = cached.records[0];
  if (!source) throw new Error("missing initial history");
  const records = Array.from({ length: 4 }, (_, index) => ({
    ...source,
    id: `committed-${index}`,
    parentId: index === 0 ? null : `committed-${index - 1}`,
  }));
  snapshot.mockReturnValue(okAsync({ ...cached, activity: "idle", records }));
  const first = (await h.pull("committed-0", 2))._unsafeUnwrap();
  expect(first).toMatchObject({
    records: records.slice(1, 3),
    cursor: "committed-2",
    headId: "committed-2",
    session: cached.session,
  });
  const last = (await h.pull(first.cursor, 2))._unsafeUnwrap();
  expect(last.records).toEqual(records.slice(3));
  const empty = (await h.pull(last.cursor, 2))._unsafeUnwrap();
  expect(empty).toMatchObject({ records: [], cursor: last.cursor, headId: last.cursor });
  expect((await h.pull("absent-from-both"))._unsafeUnwrapErr().code).toBe("cursor_not_found");
  expect(snapshot).toHaveBeenCalledTimes(4);
});

it("preserves source unavailability and does not mask non-cursor native failures", async () => {
  const h = await loaded();
  const unavailable = durableError("committed history unavailable", true);
  const snapshot = vi.spyOn(h.persistence, "snapshot").mockReturnValue(errAsync(unavailable));
  expect((await h.pull("not-cached"))._unsafeUnwrapErr()).toBe(unavailable);
  snapshot.mockClear();
  const nativeFailure = durableError("native projection failed");
  const native = vi
    .spyOn(DurableAgent.prototype, "pullHistory")
    .mockReturnValue(errAsync(nativeFailure));
  try {
    expect((await h.pull(null))._unsafeUnwrapErr()).toBe(nativeFailure);
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
  }
});
