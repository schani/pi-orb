import { NoSimulationTask, type SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedRunningOrb } from "../testkit/fixtures.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { readDisplayDetail, readLiveDisplayDetail } from "./display-detail.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";
import { pollAllOnce } from "./loops.ts";
import type { OrbRow } from "./orb.ts";

it.each(["process", "docker", "gce"] as const)(
  "polls a mixed %s fleet by native authority and reads Claude details from its host",
  async (provider) => {
    const h = makeHarness();
    const task = new NoSimulationTask("mixed harness placement", false);
    Object.defineProperty(h.deps.hostProvider, "kind", { value: provider });
    h.store.seedProject(makeProjectRow("project-a"));
    seedRunningOrb(task, h, "claude");
    h.store.seedOrb({
      ...h.store.orbSnapshot("claude")!,
      harness: "claude",
      harnessSessionId: "native",
    });
    h.store.seedOrb(makeOrbRow("claude-stopped", "project-a", "stopped", { harness: "claude" }));
    h.store.seedOrb(makeOrbRow("pi-stopped", "project-a", "stopped"));
    const pullHistory = vi.fn((_task: SimulationTask, orb: OrbRow) =>
      okAsync({
        v: 1 as const,
        orbId: orb.id,
        runtimeInstanceId: "central",
        activity: "idle" as const,
        session: { id: "central-session", overflow: {} },
        records: [],
        cursor: null,
        headId: null,
      }),
    );
    const session = vi.fn((_id: string) => null);
    const central = { placement: "central", pullHistory, session } as unknown as AgentPlane;
    const deps = {
      ...h.deps,
      agentPlane: new HarnessAgentPlane(central, new SdkAgentPlane(h.deps), h.store),
    };
    const nativePull = vi.spyOn(h.deps.runtimeClient, "pullHistory");
    await pollAllOnce(task, deps);
    expect(nativePull).toHaveBeenCalledTimes(1);
    expect(pullHistory).toHaveBeenCalledTimes(1);
    expect(pullHistory.mock.calls[0]?.[1].id).toBe("pi-stopped");
    expect(h.deps.control.getNextAttemptAt("poll:claude-stopped")).toBe(0);
    expect(h.deps.control.getLiveness("claude")?.runtimeInstanceId).toBeTruthy();
    const sessionId = h.store.orbSnapshot("claude")!.harnessSessionId!;
    const detail = {
      v: 1 as const,
      sessionId,
      recordId: "missing",
      detailKey: "missing:0",
      state: "committed" as const,
      body: { type: "reasoning" as const, text: "Native full reasoning" },
    };
    const nativeDetail = vi
      .spyOn(h.deps.runtimeClient, "readDisplayDetail")
      .mockReturnValue(okAsync(detail));
    expect(
      (
        await readDisplayDetail(task, deps, {
          orbId: "claude",
          sessionId,
          recordId: "missing",
          detailKey: "missing:0",
        })
      )._unsafeUnwrap(),
    ).toEqual(detail);
    expect(nativeDetail).toHaveBeenCalledOnce();
    const live = {
      v: 1 as const,
      sessionId,
      operationId: "operation",
      blockId: "reasoning",
      state: "running" as const,
      body: { type: "reasoning" as const, text: "Native live reasoning" },
    };
    const nativeLive = vi
      .spyOn(h.deps.runtimeClient, "readLiveDisplayDetail")
      .mockReturnValue(okAsync(live));
    expect(
      (
        await readLiveDisplayDetail(task, deps, {
          orbId: "claude",
          sessionId,
          operationId: "operation",
          blockId: "reasoning",
        })
      )._unsafeUnwrap(),
    ).toEqual(live);
    expect(nativeLive).toHaveBeenCalledOnce();
    expect(session.mock.calls.every(([id]) => id !== "claude")).toBe(true);
  },
);
