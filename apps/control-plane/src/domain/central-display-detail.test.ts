import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import type { AgentPlane, AgentSessionFacade } from "./agent-ports.ts";
import { readDisplayDetail, readDisplayImage, readLiveDisplayDetail } from "./display-detail.ts";

it("reads central live reasoning before compute readiness without guest transport or model construction", async () => {
  const task = new NoSimulationTask("central detail", false);
  const h = makeHarness();
  h.store.seedOrb({ ...makeOrbRow("orb", "project", "stopped"), harnessSessionId: "session" });
  const session: AgentSessionFacade = {
    runtimeInstanceId: "central",
    snapshot: () =>
      ok({
        orbId: "orb",
        runtimeInstanceId: "central",
        activity: "busy",
        session: { id: "session", overflow: {} },
        records: [],
        headId: null,
      }),
    liveView: () => ({
      operationId: "operation",
      operationKind: "agent",
      blocks: [
        {
          blockId: "reasoning",
          blockType: "reasoning",
          contentIndex: 0,
          revision: 2,
          text: "Full live reasoning",
        },
      ],
      tools: [],
      subagents: [],
    }),
    subscribe: () => () => undefined,
    request: () => okAsync({ type: "accepted", operationId: "operation", duplicate: false }),
  };
  const deps = {
    ...h.deps,
    agentPlane: {
      ...h.deps.agentPlane!,
      placement: "central" as const,
      session: () => session,
    } as AgentPlane,
  };
  const guest = vi.spyOn(deps.runtimeClient, "readLiveDisplayDetail");
  const ref = {
    orbId: "orb",
    sessionId: "session",
    operationId: "operation",
    blockId: "reasoning",
  };
  expect((await readLiveDisplayDetail(task, deps, ref))._unsafeUnwrap()).toEqual({
    v: 1,
    sessionId: "session",
    operationId: "operation",
    blockId: "reasoning",
    state: "running",
    body: { type: "reasoning", text: "Full live reasoning" },
  });
  expect((await readLiveDisplayDetail(task, deps, { ...ref, sessionId: "stale" })).isErr()).toBe(
    true,
  );
  expect((await readLiveDisplayDetail(task, deps, { ...ref, operationId: "stale" })).isErr()).toBe(
    true,
  );
  expect(guest).not.toHaveBeenCalled();
});

it("does not query an execution guest for absent central transcript detail", async () => {
  const task = new NoSimulationTask("missing central detail", false);
  const h = makeHarness();
  h.store.seedOrb({
    ...makeOrbRow("orb", "project", "running"),
    hostRef: "execution",
    harnessSessionId: "session",
  });
  const deps = {
    ...h.deps,
    agentPlane: { placement: "central", session: () => null } as unknown as AgentPlane,
  };
  const observe = vi.spyOn(deps.hostProvider, "observe");
  const ref = { orbId: "orb", sessionId: "session", recordId: "missing", detailKey: "missing:0" };
  expect(await readDisplayDetail(task, deps, ref)).toEqual(
    expect.objectContaining({ error: { type: "detail_missing", source: "replica" } }),
  );
  expect(await readDisplayImage(task, deps, { ...ref, imageIndex: 0 })).toEqual(
    expect.objectContaining({ error: { type: "detail_missing", source: "replica" } }),
  );
  expect(observe).not.toHaveBeenCalled();
});

it("reads committed central detail and image from the separate transcript after private authority unload", async () => {
  const task = new NoSimulationTask("central committed detail", false);
  const h = makeHarness();
  h.store.seedOrb({ ...makeOrbRow("orb", "project", "stopped"), harnessSessionId: "session" });
  const record: HistoryRecord = {
    id: "record",
    parentId: null,
    timestamp: "now",
    overflow: {},
    type: "message",
    role: "assistant",
    content: [
      { type: "reasoning", text: "Committed reasoning" },
      { type: "image", data: "eA==", mediaType: "image/png" },
    ],
  };
  vi.spyOn(h.deps.store, "readHistoryRecord").mockReturnValue(okAsync(record));
  const deps = {
    ...h.deps,
    agentPlane: {
      ...h.deps.agentPlane!,
      placement: "central" as const,
      session: () => null,
    } as AgentPlane,
  };
  const guest = vi.spyOn(deps.runtimeClient, "readDisplayDetail");
  const ref = { orbId: "orb", sessionId: "session", recordId: "record", detailKey: "record:0" };
  expect((await readDisplayDetail(task, deps, ref))._unsafeUnwrap().body).toEqual({
    type: "reasoning",
    text: "Committed reasoning",
  });
  expect(
    (await readDisplayImage(task, deps, { ...ref, detailKey: "record:1", imageIndex: 0 }))
      ._unsafeUnwrap()
      .data.toString(),
  ).toBe("x");
  expect(guest).not.toHaveBeenCalled();
});
