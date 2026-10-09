import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";

it.each(["central", "host"] as const)(
  "routes immutable harness selection with Pi %s",
  async (placement) => {
    const h = makeHarness();
    const pi = makeOrbRow("pi", "project", "running");
    const claude = { ...makeOrbRow("claude", "project", "running"), harness: "claude" as const };
    h.store.seedOrb(pi);
    h.store.seedOrb(claude);
    const makePlane = (kind: "central" | "host") => ({
      placement: kind,
      health: vi.fn(() => okAsync({})),
      deliverMessage: vi.fn(() => okAsync({})),
      prepareIdleStop: vi.fn(() => okAsync({})),
      pullHistory: vi.fn(() => okAsync({})),
      suspend: vi.fn(() => okAsync(undefined)),
      dispose: vi.fn(() => okAsync(undefined)),
      session: vi.fn(() => null),
      close: vi.fn(() => okAsync(undefined)),
    });
    const host = makePlane("host");
    const selected = makePlane(placement);
    const plane = new HarnessAgentPlane(
      selected as unknown as AgentPlane,
      host as unknown as AgentPlane,
      h.store,
    );
    const task = new NoSimulationTask("harness dispatch", false);
    const context = { signal: new AbortController().signal };
    for (const orb of [pi, claude]) {
      expect(plane.placementFor(orb)).toBe(orb.harness === "claude" ? "host" : placement);
      await plane.health(task, orb, context);
      await plane.deliverMessage(task, orb, {} as never, context);
      await plane.prepareIdleStop(task, orb, context);
      await plane.pullHistory(task, orb, {} as never, context);
      await plane.suspend(task, orb.id, context, 3);
      await plane.dispose(task, orb.id, false, context);
    }
    for (const method of [
      "health",
      "deliverMessage",
      "prepareIdleStop",
      "pullHistory",
      "suspend",
      "dispose",
    ] as const) {
      expect(host[method]).toHaveBeenCalledTimes(1);
      expect(selected[method]).toHaveBeenCalledTimes(1);
    }
    await plane.close();
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(selected.close).toHaveBeenCalledTimes(1);
  },
);
