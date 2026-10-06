import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import type { AgentPlane } from "./agent-ports.ts";
import {
  reconcileOrbOnce,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbStop,
} from "./lifecycle.ts";

it("closes execution on Stop and sleep override while preserving central conversation", async () => {
  const task = new NoSimulationTask("stop subscriptions", false);
  for (const central of [true, false]) {
    for (const state of ["running", "stopping", "stopped"] as const) {
      const h = makeHarness();
      h.store.seedOrb(
        makeOrbRow("orb", "p", state, state === "stopping" ? { stopReason: "sleep" } : {}),
      );
      let conversationClosed = 0;
      let executionClosed = 0;
      h.deps.control.registerBrowserConnection("orb", "browser", () => {
        conversationClosed++;
      });
      h.deps.control.registerBrowserConnection(
        "orb",
        "pty",
        () => {
          executionClosed++;
        },
        "execution",
      );
      h.deps.control.setBrowserVisibility("orb", "pty", true, task.wallNow());
      const deps = central
        ? {
            ...h.deps,
            agentPlane: {
              placement: "central",
              suspend: () => okAsync(undefined),
            } as unknown as AgentPlane,
          }
        : h.deps;
      expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
      expect(h.store.orbSnapshot("orb")?.stopReason).toBe("manual");
      expect(conversationClosed).toBe(central ? 0 : 1);
      expect(executionClosed).toBe(1);
      expect(h.deps.control.hasVisibleBrowser("orb")).toBe(false);
      expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
      expect(executionClosed).toBe(1);
      expect(conversationClosed).toBe(central ? 0 : 1);
      h.deps.control.unregisterBrowserConnection("orb", "pty", task.wallNow());
      expect((await requestOrbDeletion(task, deps, "orb")).isOk()).toBe(true);
      expect(conversationClosed).toBe(1);
      expect(executionClosed).toBe(1);
    }
  }
});

it.each([false, true])(
  "closes execution on reconciliation and host loss, central: %s",
  async (central) => {
    const task = new NoSimulationTask("lost execution", false);
    for (const state of ["running", "stopping"] as const) {
      const h = makeHarness();
      h.store.seedOrb(makeOrbRow("orb", "p", state));
      let conversation = 0;
      let execution = 0;
      h.deps.control.registerBrowserConnection("orb", "conversation", () => conversation++);
      h.deps.control.registerBrowserConnection("orb", "execution", () => execution++, "execution");
      const deps = central
        ? {
            ...h.deps,
            agentPlane: { placement: "central", session: () => null } as unknown as AgentPlane,
          }
        : h.deps;
      const outcome = await reconcileOrbOnce(task, deps, "orb");
      expect(outcome).toEqual({
        type: "transitioned",
        toState: state === "running" ? "starting" : "stopped",
      });
      expect(execution).toBe(1);
      expect(conversation).toBe(central ? 0 : 1);
    }
  },
);

it.each([false, true])("deletion closes both scopes immediately, central: %s", async (central) => {
  const task = new NoSimulationTask("delete subscriptions", false);
  const h = makeHarness();
  h.store.seedOrb(makeOrbRow("orb", "p", "running"));
  let conversation = 0;
  let execution = 0;
  h.deps.control.registerBrowserConnection("orb", "conversation", () => conversation++);
  h.deps.control.registerBrowserConnection("orb", "execution", () => execution++, "execution");
  const deps = central
    ? {
        ...h.deps,
        agentPlane: { placement: "central" } as unknown as AgentPlane,
      }
    : h.deps;
  expect((await requestOrbDeletion(task, deps, "orb")).isOk()).toBe(true);
  expect((await requestOrbDeletion(task, deps, "orb")).isOk()).toBe(true);
  expect(conversation).toBe(1);
  expect(execution).toBe(1);
});

it.each([false, true])(
  "archive closes execution immediately, central conversation drains until finalization: %s",
  async (central) => {
    const task = new NoSimulationTask("archive subscriptions", false);
    const h = makeHarness();
    h.store.seedOrb(makeOrbRow("orb", "p", "running"));
    let conversation = 0;
    let execution = 0;
    h.deps.control.registerBrowserConnection("orb", "conversation", () => conversation++);
    h.deps.control.registerBrowserConnection("orb", "execution", () => execution++, "execution");
    const deps = central
      ? {
          ...h.deps,
          agentPlane: { placement: "central" } as unknown as AgentPlane,
        }
      : h.deps;
    expect((await requestOrbArchive(task, deps, "orb")).isOk()).toBe(true);
    expect(execution).toBe(1);
    expect(conversation).toBe(central ? 0 : 1);
    h.deps.control.clearOrb("orb");
    expect(execution).toBe(1);
    expect(conversation).toBe(1);
  },
);
