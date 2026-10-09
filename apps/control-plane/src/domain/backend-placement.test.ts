import { NoSimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedRunningOrb } from "../testkit/fixtures.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";
import { reconcileOrbOnce } from "./lifecycle.ts";
import { pollAllOnce } from "./loops.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

const providers = ["process", "docker", "gce"] as const;

function fixture(provider: string, placement: "host" | "central" = "host") {
  const harness = makeHarness();
  Object.defineProperty(harness.deps.hostProvider, "kind", { value: provider });
  const plane = new SdkAgentPlane(harness.deps);
  if (placement === "central") Object.defineProperty(plane, "placement", { value: placement });
  return {
    ...harness,
    deps: {
      ...harness.deps,
      agentPlane: new HarnessAgentPlane(plane, new SdkAgentPlane(harness.deps), harness.store),
    },
  };
}

function clock() {
  const task = new NoSimulationTask("backend placement", false);
  let now = 1_000;
  vi.spyOn(task, "monotonicNow").mockImplementation(() => now);
  vi.spyOn(task, "wallNow").mockImplementation(() => now);
  return {
    task,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe.each(providers)("%s backend placement", (provider) => {
  it.each([
    { placement: "host", harness: "pi" },
    { placement: "central", harness: "pi" },
    { placement: "central", harness: "claude" },
  ] as const)(
    "requests a stable initial pin gate only for central Pi: %o",
    async ({ placement, harness }) => {
      const h = fixture(provider, placement);
      const { task } = clock();
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(
        makeOrbRow("orb", "project", "creating", { harness, checkoutCommit: "a".repeat(40) }),
      );
      const provision = vi.spyOn(h.deps.hostProvider, "provision");
      await reconcileOrbOnce(task, h.deps, "orb");
      expect(provision).toHaveBeenCalledOnce();
      expect(provision.mock.calls[0]?.[1].bootstrap).toEqual({
        repositoryUrl: makeProjectRow("project").repositoryUrl,
        harness,
        ...(placement === "central" && harness === "pi"
          ? { awaitInitialCheckoutCommit: true }
          : {}),
      });
    },
  );

  it("keeps SDK busy pulls authoritative for activity and idle-stop admission", async () => {
    const h = fixture(provider);
    const { task, advance } = clock();
    seedRunningOrb(task, h, "orb");
    h.deps.control.noteStateEpisode("orb", task.wallNow());
    h.world.setActivity("orb", "busy");
    h.deps.control.resetLivenessBaseline("orb", task.monotonicNow());
    expect((await pollOrbUntilCaughtUp(task, h.deps, "orb", 1)).type).toBe("caught_up");
    expect(h.deps.control.getLiveness("orb")?.activity).toBe("busy");
    expect(h.store.orbSnapshot("orb")?.lastBusyAt).toBe(task.wallNow());
    advance(h.deps.constants.idleStopAfterMs + 1);
    await reconcileOrbOnce(task, h.deps, "orb");
    expect(h.store.orbSnapshot("orb")?.state).toBe("running");
  });

  it("starts SDK silence on failed pulls and recovers the dead guest without inbox input", async () => {
    const h = fixture(provider);
    const { task, advance } = clock();
    seedRunningOrb(task, h, "orb");
    h.deps.control.noteStateEpisode("orb", task.wallNow());
    h.deps.control.resetLivenessBaseline("orb", task.monotonicNow());
    const unavailable = () =>
      errAsync({
        type: "runtime_client_error" as const,
        code: "unreachable" as const,
        answered: false,
        retryable: true,
        message: "guest unavailable",
      });
    vi.spyOn(h.deps.runtimeClient, "pullHistory").mockImplementation(unavailable);
    vi.spyOn(h.deps.runtimeClient, "health").mockImplementation(unavailable);
    const stop = vi.spyOn(h.deps.hostProvider, "stop");
    const start = vi.spyOn(h.deps.hostProvider, "start");
    expect((await pollOrbUntilCaughtUp(task, h.deps, "orb", 1)).type).toBe("retryable");
    expect(h.deps.control.getLiveness("orb")?.unansweredSinceAt).toBe(task.monotonicNow());
    advance(h.deps.constants.unreachableGraceMs + 1);
    await reconcileOrbOnce(task, h.deps, "orb");
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(h.store.orbSnapshot("orb")?.state).toBe("starting");
  });

  it("starts SDK silence only after the second host observation reaches guest transport", async () => {
    const h = fixture(provider);
    const { task, advance } = clock();
    seedRunningOrb(task, h, "orb");
    h.deps.control.resetLivenessBaseline("orb", task.monotonicNow());
    const originalObserve = h.deps.hostProvider.observe.bind(h.deps.hostProvider);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const observe = vi.spyOn(h.deps.hostProvider, "observe");
    observe.mockImplementationOnce(originalObserve);
    observe.mockImplementationOnce((...args) => {
      reached();
      return ResultAsync.fromSafePromise(held).andThen(() => originalObserve(...args));
    });
    const guest = vi.spyOn(h.deps.runtimeClient, "pullHistory");
    const started = vi.spyOn(h.deps.control, "noteRuntimeRequestStarted");
    const poll = pollOrbUntilCaughtUp(task, h.deps, "orb", 1);
    await observing;
    const callsWhileHeld = guest.mock.calls.length;
    const startsWhileHeld = started.mock.calls.length;
    const silenceWhileHeld = h.deps.control.getLiveness("orb")?.unansweredSinceAt;
    advance(h.deps.constants.unreachableGraceMs + 1);
    release();
    expect((await poll).type).toBe("caught_up");
    expect(callsWhileHeld).toBe(0);
    expect(startsWhileHeld).toBe(0);
    expect(silenceWhileHeld).toBeNull();
    expect(guest).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledExactlyOnceWith("orb", task.monotonicNow());
    expect(h.deps.control.getLiveness("orb")?.unansweredSinceAt).toBeNull();
  });

  it("ends SDK silence when a pull answers", async () => {
    const h = fixture(provider);
    const { task, advance } = clock();
    seedRunningOrb(task, h, "orb");
    h.deps.control.resetLivenessBaseline("orb", task.monotonicNow());
    h.deps.control.noteRuntimeRequestStarted("orb", task.monotonicNow());
    advance(100);
    await pollOrbUntilCaughtUp(task, h.deps, "orb", 1);
    expect(h.deps.control.getLiveness("orb")?.unansweredSinceAt).toBeNull();
    expect(h.deps.control.getLiveness("orb")?.lastSuccessAt).toBe(task.monotonicNow());
  });

  it("does not poll stopped SDK guests", async () => {
    const h = fixture(provider);
    const { task } = clock();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
    const observe = vi.spyOn(h.deps.hostProvider, "observe");
    await pollAllOnce(task, h.deps);
    expect(observe).not.toHaveBeenCalled();
    expect(h.deps.control.getNextAttemptAt("poll:orb")).toBe(0);
  });
});
