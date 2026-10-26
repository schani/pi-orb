import type { SimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import type { HealthOverride } from "../testkit/world.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { ControlState } from "./control-state.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";
import { reconcileOrbOnce, requestOrbSleep, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { orphanSweepOnce, pollAllOnce } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";

const ORB = "environment-orb";
const first = Number(process.env["EXECUTION_CAMPAIGN_FIRST_SEED"] ?? 0);
const count = Number(process.env["EXECUTION_CAMPAIGN_SEEDS"] ?? 256);

async function environment(task: SimulationTask, placement: "host" | "central") {
  const h = makeHarness();
  seedRunningOrb(task, h, ORB);
  function snapshot() {
    const orb = h.store.orbSnapshot(ORB);
    if (!orb) throw new Error("environment fixture disappeared");
    return orb;
  }
  const initial = snapshot();
  h.store.seedOrb({ ...initial, harness: task.random("harness") < 0.5 ? "pi" : "claude" });
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
  let phase = { errors: new Set<string>(), protectedVersion: -1, incarnation: -1, terminal: false };
  let pendingHealth: { offset: number; value: HealthOverride | null } | null = null;
  function monitor<T extends object>(port: T, external: boolean): T {
    return new Proxy(port, {
      get(target, key) {
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (health.incarnation !== snapshot().hostIncarnation) {
            applyHealth(null);
            task.log("lifecycle: environment semantic-health-reset reason=incarnation_retired");
          }
          if (pendingHealth && pendingHealth.offset-- === 0) {
            applyHealth(pendingHealth.value);
            task.log(
              `lifecycle: environment semantic-health=${health.value && "status" in health.value ? health.value.status : health.value ? "malformed" : "ready"}`,
            );
            pendingHealth = null;
          }
          const current = phase;
          const result: unknown = Reflect.apply(method, target, args);
          return result instanceof ResultAsync
            ? result.mapErr((error: unknown) => {
                current.errors.add(
                  !external
                    ? "store"
                    : typeof error === "object" &&
                        error !== null &&
                        "answered" in error &&
                        error.answered === true
                      ? "answered"
                      : "unanswered",
                );
                return error;
              })
            : result;
        };
      },
    });
  }
  const observed: { incarnation: number; code: string }[] = [];
  const probe = h.deps.runtimeClient.health.bind(h.deps.runtimeClient);
  h.deps.runtimeClient.health = (t, url, context) =>
    probe(t, url, context).map((status) => {
      if (status.status === "failed" && status.orbId === ORB) {
        phase.terminal = true;
        const orb = snapshot();
        if (
          observed.at(-1)?.incarnation !== orb.hostIncarnation ||
          observed.at(-1)?.code !== status.error.code
        )
          t.log(
            `lifecycle: environment terminal-observed state=${orb.state} code=${status.error.code} incarnation=${orb.hostIncarnation}`,
          );
        observed.push({ incarnation: orb.hostIncarnation, code: status.error.code });
      }
      return status;
    });
  let deps: ControlPlaneDeps = {
    ...h.deps,
    store: monitor(h.store, false),
    runtimeClient: monitor(h.deps.runtimeClient, true),
    hostProvider: monitor(h.deps.hostProvider, true),
  };
  function route() {
    const sdk = new SdkAgentPlane(deps);
    deps = {
      ...deps,
      agentPlane: placement === "central" ? new HarnessAgentPlane(plane, sdk, deps.store) : sdk,
    };
  }
  route();
  let intent: "stop" | "start" | "sleep" | null = null;
  const fail = h.store.failOrbAndRequestComputeDiscard.bind(h.store);
  h.store.failOrbAndRequestComputeDiscard = (t, params) => {
    const current = h.store.orbSnapshot(ORB);
    if (
      !phase.errors.has("unanswered") &&
      !phase.terminal &&
      current?.stateVersion === phase.protectedVersion &&
      current.hostIncarnation === phase.incarnation
    )
      expect.fail("healthy current execution cannot fail from local store faults");
    if (
      current &&
      (current.state === "stopping" ||
        current.stopReason === "manual" ||
        current.stopReason === "sleep" ||
        current.sleepId !== null)
    )
      expect(
        params.recoveryEpisode,
        "stopping/Stop/sleep never authorize automatic replacement",
      ).toBeUndefined();
    return fail(t, params);
  };
  const health: { value: HealthOverride | null; incarnation: number } = {
    value: null,
    incarnation: initial.hostIncarnation,
  };
  function applyHealth(value: HealthOverride | null) {
    const incarnation = snapshot().hostIncarnation;
    if (health.incarnation !== incarnation) health.value = null;
    if (!(health.value && "status" in health.value && health.value.status === "failed"))
      health.value = value;
    else if (value !== health.value)
      task.log("lifecycle: environment semantic-health-ignored reason=terminal_execution");
    health.incarnation = incarnation;
    h.world.setHealth(ORB, health.value);
  }
  const pick = <T>(values: readonly T[], reason: string): T =>
    values[Math.floor(task.random(reason) * values.length)] as T;
  async function pass(kind: "compute" | "history") {
    const before = h.store.orbSnapshot(ORB);
    if (!before) return;
    const runtime = h.world.resolveRuntime(`http://${before.hostRef}:8080`, task);
    const status = runtime ? h.world.runtimeHealth(task, runtime) : null;
    const current =
      before.hostDiscardThroughIncarnation === null && h.world.hostStateOf(ORB) === "running";
    phase = {
      errors: new Set<string>(),
      terminal: false,
      incarnation: before.hostIncarnation,
      protectedVersion:
        current &&
        ["running", "stopping"].includes(before.state) &&
        status !== null &&
        status.status !== "failed"
          ? before.stateVersion
          : -1,
    };
    if (kind === "history") await pollAllOnce(task, deps);
    else {
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await reconcileOrbOnce(task, deps, ORB);
        if (outcome.type !== "conflict") break;
      }
    }
    phase.protectedVersion = -1;
  }
  const generateHealth = () =>
    pick<HealthOverride | null>(
      [
        null,
        { status: "initializing", phase: "booting" },
        ...["execution_failed", "session_load_failed", "claude_child_recovery_required"].map(
          (code): HealthOverride => ({
            status: "failed",
            error: {
              code,
              message: "generated terminal failure",
              retryable: code === "execution_failed",
            },
            recovery: { episode: "a".repeat(64) },
          }),
        ),
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
  const semanticEvents = Array.from({ length: 128 }, () => ({
    offset: pick([0, 1, 4, 16, 64], "semantic dependency offset"),
    value: generateHealth(),
  }));
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
      applyHealth(generateHealth());
    },
    reachability: () =>
      h.world.setRuntimeUnreachable(task, ORB, pick([0, 600_000], "reachability")),
    provider: () => h.world.preemptHost(task, ORB, 0),
    activity: () => {
      h.world.setActivity(ORB, pick(["idle", "busy"], "guest activity"));
      centralBusy = pick([false, true], "central activity");
      central.world.setActivity(ORB, centralBusy ? "busy" : "idle");
    },
    stop: async () => {
      if ((await requestOrbStop(task, deps, ORB)).isOk()) intent = "stop";
    },
    start: async () => {
      if ((await requestOrbStart(task, deps, ORB)).isOk()) intent = "start";
    },
    sleep: async () => {
      const orb = snapshot();
      const result = await requestOrbSleep(
        task,
        deps,
        ORB,
        {
          runtimeTokenHash: orb.runtimeTokenHash ?? "revoked",
          hostIncarnation: orb.hostIncarnation,
        },
        pick([1, 120, 600], "sleep duration"),
        `sleep-${ordinal++}`,
      );
      if (result.isOk()) intent = "sleep";
    },
    elapsed: () => task.sleep(pick([1_000, 15_000, 360_000], "elapsed time"), "environment time"),
    controller: () => {
      deps = { ...deps, control: new ControlState() };
      route();
    },
    stabilize: () => fairSuffix(),
    compute: () => pass("compute"),
    history: async () => {
      if (placement === "central" && snapshot().harness === "pi") central.world.appendMessage(ORB);
      else if (h.world.sessionHeaderOf(ORB)) h.world.appendMessage(ORB);
      await pass("history");
    },
  };
  async function fairSuffix() {
    pendingHealth = null;
    // Faults end, not the execution's terminal condition. New compute may be healthy.
    h.store.clearOperationFaults();
    deps = { ...deps, control: new ControlState() };
    route();
    h.world.setRuntimeUnreachable(task, ORB, 0);
    centralBusy = false;
    h.world.setActivity(ORB, "idle");
    central.world.setActivity(ORB, "idle");
    const terminalIncarnation =
      health.value && "status" in health.value && health.value.status === "failed"
        ? snapshot().hostIncarnation
        : null;
    const initializing =
      health.value && "status" in health.value && health.value.status === "initializing";
    if (health.value && "type" in health.value) health.value = null;
    h.world.setHealth(ORB, health.value);
    observed.length = 0;
    const c = deps.constants;
    const remainingSleep = Math.max(
      0,
      (h.store.orbSnapshot(ORB)?.sleepUntil ?? 0) - task.wallNow(),
    );
    const deadline =
      task.monotonicNow() +
      remainingSleep +
      c.createStartDeadlineMs +
      c.setupHookHoldMs +
      c.postRestartGraceMs +
      c.hostBackstopIntervalMs;
    while (task.monotonicNow() <= deadline) {
      if (
        terminalIncarnation !== null &&
        h.store.orbSnapshot(ORB)?.hostIncarnation !== terminalIncarnation
      ) {
        applyHealth(null);
      }
      await pass("compute");
      await pass("history");
      await orphanSweepOnce(task, deps);
      const orb = snapshot();
      const retired =
        h.world.hostStateOf(ORB) !== "running" &&
        orb.hostDiscardThroughIncarnation === null &&
        ["stopped", "failed"].includes(orb.state);
      const runtime = h.world.resolveRuntime(`http://${orb.hostRef}:8080`, task);
      const recovered =
        orb.state === "running" &&
        runtime !== null &&
        h.world.runtimeHealth(task, runtime).status === "ready";
      if (orb.sleepId === null && (retired || (intent !== "stop" && recovered))) {
        const terminal = observed.at(-1);
        if (retired && terminal) {
          expect(orb.state, "observed terminal health has a durable disposition").toBe("failed");
          expect(orb.lastError).toContain(terminal.code);
        }
        return;
      }
      await task.sleep(c.reconcileTickMs, "fair environment suffix");
    }
    if (initializing) return; // An indefinitely initializing guest owes safety, not completion.
    expect.fail(
      `execution must recover or retire after finite faults: ${JSON.stringify(h.store.orbSnapshot(ORB))}`,
    );
  }

  let ordinal = 0;
  for (let step = 0; step < 128; step++) {
    const command = pick(Object.keys(actions) as (keyof typeof actions)[], "environment command");
    pendingHealth = semanticEvents[step] ?? null;
    await task.checkpoint("environment command", step, command);
    task.log(`lifecycle: environment command=${command} state=${h.store.orbSnapshot(ORB)?.state}`);
    await actions[command]();
    const quanta = pick([0, 1, 3], "ordinary worker quanta");
    for (let quantum = 0; quantum < quanta; quantum++) {
      await pass("compute");
      await pass("history");
      await task.sleep(deps.constants.reconcileTickMs, "ordinary workers");
    }
    pendingHealth = null;
    if ((step + 1) % 32 === 0) await fairSuffix();
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
