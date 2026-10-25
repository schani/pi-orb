import type { SimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import type { HealthOverride } from "../testkit/world.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

const ORB = "environment-orb";
const first = Number(process.env["EXECUTION_CAMPAIGN_FIRST_SEED"] ?? 0);
const count = Number(process.env["EXECUTION_CAMPAIGN_SEEDS"] ?? 256);

async function environment(task: SimulationTask, placement: "host" | "central") {
  const h = makeHarness();
  seedRunningOrb(task, h, ORB);
  const central = makeHarness();
  seedRunningOrb(task, central, ORB);
  const url = `http://${central.store.orbSnapshot(ORB)?.hostRef}:8080`;
  let centralBusy = false;
  const plane: AgentPlane = {
    placement: "central",
    health: (t, _o, c) => central.deps.runtimeClient.health(t, url, c),
    deliverMessage: (t, _o, r, c) =>
      central.deps.runtimeClient.deliverMessage(t, { ...r, baseUrl: url }, c),
    pullHistory: (t, _o, r, c) =>
      central.deps.runtimeClient.pullHistory(t, { ...r, baseUrl: url }, c),
    prepareIdleStop: () => okAsync({ v: 1, prepared: true }),
    suspend: () => okAsync(undefined),
    dispose: () => okAsync(undefined),
    session: () => ({
      runtimeInstanceId: "central",
      workActive: () => centralBusy,
      snapshot: () => err({ message: "not projected" }),
      liveView: () => null,
      subscribe: () => () => undefined,
      request: () =>
        errAsync({
          type: "runtime_client_error",
          code: "invalid_response",
          answered: true,
          retryable: false,
          message: "not used",
        }),
    }),
    close: () => okAsync(undefined),
  };
  let phase = { errors: new Set<string>(), protectedVersion: -1, incarnation: -1 };
  function monitor<T extends object>(port: T, external: boolean): T {
    return new Proxy(port, {
      get(target, key) {
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const current = phase;
          const result: unknown = Reflect.apply(method, target, args);
          return result instanceof ResultAsync
            ? result.mapErr((error: unknown) => {
                current.errors.add(external ? "external" : "store");
                return error;
              })
            : result;
        };
      },
    });
  }
  let deps = {
    ...h.deps,
    store: monitor(h.store, false),
    runtimeClient: monitor(h.deps.runtimeClient, true),
    hostProvider: monitor(h.deps.hostProvider, true),
    ...(placement === "central" ? { agentPlane: monitor(plane, true) } : {}),
  };
  const fail = h.store.failOrbAndRequestComputeDiscard.bind(h.store);
  h.store.failOrbAndRequestComputeDiscard = (t, params) => {
    const current = h.store.orbSnapshot(ORB);
    if (
      !phase.errors.has("external") &&
      current?.stateVersion === phase.protectedVersion &&
      current.hostIncarnation === phase.incarnation
    )
      expect.fail("healthy current execution cannot fail from local store faults");
    return fail(t, params);
  };
  let health: HealthOverride | null = null;
  const pick = <T>(values: readonly T[], reason: string): T =>
    values[Math.floor(task.random(reason) * values.length)] as T;
  async function pass(kind: "compute" | "history") {
    const before = h.store.orbSnapshot(ORB);
    if (!before) return;
    const runtime = h.world.resolveRuntime(`http://${before.hostRef}:8080`, task);
    const status =
      runtime && !(health && "type" in health) ? h.world.runtimeHealth(task, runtime) : null;
    const current =
      before.hostDiscardThroughIncarnation === null && h.world.hostStateOf(ORB) === "running";
    phase = {
      errors: new Set<string>(),
      incarnation: before.hostIncarnation,
      protectedVersion:
        current && ["running", "stopping"].includes(before.state) && status?.status === "ready"
          ? before.stateVersion
          : -1,
    };
    if (kind === "history") await pollOrbUntilCaughtUp(task, deps, ORB, 1);
    else {
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await reconcileOrbOnce(task, deps, ORB);
        if (outcome.type !== "conflict") break;
      }
      const after = h.store.orbSnapshot(ORB);
      if (
        placement === "central" &&
        current &&
        before.state === "running" &&
        status?.status === "failed" &&
        phase.errors.size === 0 &&
        after?.hostIncarnation === before.hostIncarnation
      )
        expect(after.state).toBe("failed");
    }
    phase.protectedVersion = -1;
  }
  const actions = {
    fault: () => {
      const boundaries = [...h.store.observedBoundaries];
      if (!boundaries.length) return;
      const reason = pick(boundaries, "store boundary");
      const code = pick(["invariant", "unavailable"] as const, "store error class");
      h.store.setOperationFault(reason, {
        type: "store_error",
        code,
        retryable: code === "unavailable",
        message: `injected ${reason}`,
      });
    },
    clear: () => h.store.clearOperationFaults(),
    health: () => {
      health = pick<HealthOverride | null>(
        [
          null,
          { status: "initializing", phase: "booting" },
          {
            status: "failed",
            error: { code: "execution_failed", message: "failed", retryable: true },
          },
          {
            type: "runtime_client_error",
            code: "invalid_response",
            answered: true,
            retryable: true,
            message: "malformed",
          },
        ],
        "guest health",
      );
      h.world.setHealth(ORB, health);
    },
    reachability: () =>
      h.world.setRuntimeUnreachable(task, ORB, pick([0, 600_000], "reachability")),
    provider: () => h.world.preemptHost(task, ORB, 0),
    activity: () => {
      h.world.setActivity(ORB, pick(["idle", "busy"], "guest activity"));
      centralBusy = pick([false, true], "central activity");
      central.world.setActivity(ORB, centralBusy ? "busy" : "idle");
    },
    stop: () => requestOrbStop(task, deps, ORB),
    start: () => requestOrbStart(task, deps, ORB),
    elapsed: () => task.sleep(pick([1_000, 15_000, 360_000], "elapsed time"), "environment time"),
    controller: () => {
      deps = { ...deps, control: new ControlState() };
    },
    compute: () => pass("compute"),
    history: async () => {
      if (placement === "central") central.world.appendMessage(ORB);
      else if (h.world.sessionHeaderOf(ORB)) h.world.appendMessage(ORB);
      await pass("history");
    },
  };
  for (let step = 0; step < 128; step++) {
    const command = pick(Object.keys(actions) as (keyof typeof actions)[], "environment command");
    await task.checkpoint("environment command", step, command);
    await actions[command]();
  }
}

// Every production pass joins before another environment mutation.
for (const placement of ["host", "central"] as const) {
  for (let seed = first; seed < first + count; seed++) {
    it(`execution environment ${placement} seed ${seed}`, async ({ signal }) => {
      await runDst(
        {
          name: `execution-environment-${placement}-${seed}`,
          seed,
          iterations: 1,
          signal,
          logCapture: new LogCapture(),
          maxVirtualDurationMs: 30_000_000,
        },
        async (sim) => {
          const result = await sim.runTasks([
            { name: "environment", f: (task) => environment(task, placement) },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.stack : "").toBe(true);
        },
      );
    });
  }
}
