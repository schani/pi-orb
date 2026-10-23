import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  type EntropySource,
  type Logger,
  type PendingTimerView,
  RecordingTraceSource,
  ReplayingTraceSource,
  SimpleEntropySource,
  type Simulation,
  SimulationImpl,
  type SimulationTask,
} from "determined";
import { failureIdentity } from "../../../../testkit/failure-identity.ts";
import { LIFECYCLE_LOG_PREFIX } from "../domain/log.ts";

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

/**
 * Captures the app-level lifecycle log of a simulation so scenarios can assert
 * on what the control plane would have written to Cloud Logging
 * (docs/testing.md). The simulation logger also receives the scheduler's own
 * timer/checkpoint/entropy chatter; only lines carrying `LIFECYCLE_LOG_PREFIX`
 * are retained, so "a healthy fleet logs nothing" is assertable.
 */
export class LogCapture implements Logger {
  private readonly captured: string[] = [];

  log(...parts: readonly unknown[]): void {
    // Cheap rejection of scheduler noise before any string building.
    if (!parts.some((part) => typeof part === "string" && part.startsWith(LIFECYCLE_LOG_PREFIX))) {
      return;
    }
    this.captured.push(
      parts.map((part) => (typeof part === "string" ? part : String(part))).join(" "),
    );
  }

  error(...parts: readonly unknown[]): void {
    this.log(...parts);
  }

  /** Called by `runDst` before each iteration: every schedule asserts on its own log. */
  reset(): void {
    this.captured.length = 0;
  }

  lines(): readonly string[] {
    return this.captured;
  }

  /** Every captured line containing `pattern` (a plain substring). */
  matching(pattern: string): readonly string[] {
    return this.captured.filter((line) => line.includes(pattern));
  }
}

/** Wait in bounded virtual steps so late-timer exploration cannot skip unrelated deadlines. */
export async function sleepInSteps(
  task: SimulationTask,
  totalMs: number,
  reason: string,
): Promise<void> {
  const until = task.monotonicNow() + totalMs;
  while (task.monotonicNow() < until) {
    await task.sleep(Math.min(until - task.monotonicNow(), 500), reason);
  }
}

export interface DstOptions {
  readonly name: string;
  readonly iterations?: number;
  /** Reproducible command and scheduler exploration; recorded traces remain authoritative. */
  readonly seed?: number;
  /** Failure probability per failpoint name; unnamed failpoints never fire. */
  readonly failpointProbabilities?: Readonly<Record<string, number>>;
  readonly maxSchedulingSteps?: number;
  readonly maxVirtualDurationMs?: number;
  readonly wallClockEpoch?: number;
  /** Override late timer exploration when a scenario isolates non-timeout behavior. */
  readonly lateTimerProbability?: number;
  /** Collects the app-level log lines of every iteration (reset per iteration). */
  readonly logCapture?: LogCapture;
  /** Stops before the next iteration once aborted (pass Vitest's test `signal`). */
  readonly signal?: AbortSignal;
}

/** Fixed epoch so wall-clock assertions are stable: 2026-01-01T00:00:00Z. */
export const TEST_WALL_EPOCH = 1_767_225_600_000;

/**
 * Bias timer firing strongly toward earlier deadlines so virtual time does
 * not gallop past heartbeats, while still occasionally exploring late
 * firings.
 */
function pickTimerBiasedEarliest(
  timers: readonly PendingTimerView[],
  _now: number,
  random: (reason: string) => number,
  lateTimerProbability: number,
): number {
  let earliest = 0;
  for (let i = 1; i < timers.length; i++) {
    const timer = timers[i];
    const current = timers[earliest];
    if (timer !== undefined && current !== undefined && timer.deadline < current.deadline) {
      earliest = i;
    }
  }
  if (random("timer pick: explore late firing") < lateTimerProbability) {
    return Math.floor(random("timer pick: index") * timers.length);
  }
  return earliest;
}

export function makeSimulation(options: DstOptions, entropy: EntropySource): SimulationImpl {
  const probabilities = options.failpointProbabilities ?? {};
  return new SimulationImpl(
    options.logCapture ?? silentLogger,
    entropy,
    (...log: readonly unknown[]) => {
      const name = log[0];
      if (typeof name === "string") return probabilities[name] ?? 0;
      return 0;
    },
    {
      wallClockEpoch: options.wallClockEpoch ?? TEST_WALL_EPOCH,
      maxSchedulingSteps: options.maxSchedulingSteps ?? 200_000,
      maxVirtualDurationMs: options.maxVirtualDurationMs ?? 24 * 3_600_000,
      failOnLateCompletion: false,
      pickTimerIndex: (timers, now, random) => {
        const index = pickTimerBiasedEarliest(
          timers,
          now,
          random,
          options.lateTimerProbability ?? 0.05,
        );
        const chosen = timers[index];
        if (chosen && timers.some((timer) => timer.deadline < chosen.deadline))
          options.logCapture?.log(`dst: non-earliest timer deadline=${chosen.deadline} now=${now}`);
        return index;
      },
    },
  );
}

/**
 * Runs `scenario` under many recorded entropy schedules. On failure the full
 * trace is saved to `test-failures/`, replayed once to prove the failure
 * reproduces, and rethrown wrapped with the trace path. Set the `DST_REPLAY`
 * environment variable to a saved trace file to re-run only that schedule.
 * `nextPhase` creates a fresh simulation sharing the scenario's trace and options;
 * only its wall-clock epoch may change. Capture resets per scenario, not per phase.
 */
export async function runDst(
  options: DstOptions,
  scenario: (
    sim: Simulation,
    nextPhase: (overrides?: Pick<DstOptions, "wallClockEpoch">) => Simulation,
  ) => Promise<void>,
): Promise<void> {
  const runScenario = (entropy: EntropySource) => {
    const nextPhase = (overrides?: Pick<DstOptions, "wallClockEpoch">) =>
      makeSimulation({ ...options, ...overrides }, entropy);
    return scenario(nextPhase(), nextPhase);
  };
  const replayPath = process.env["DST_REPLAY"];
  if (replayPath !== undefined && replayPath !== "") {
    const { readFileSync } = await import("node:fs");
    const trace = JSON.parse(readFileSync(replayPath, "utf8"));
    options.logCapture?.reset();
    await runScenario(new ReplayingTraceSource(trace.records));
    return;
  }

  const iterations = options.iterations ?? 30;
  for (let i = 0; i < iterations; i++) {
    options.signal?.throwIfAborted();
    let seed = ((options.seed ?? 0) + i) >>> 0;
    const entropy: EntropySource =
      options.seed === undefined
        ? new SimpleEntropySource()
        : {
            random: () => {
              seed = (seed + 0x6d2b79f5) >>> 0;
              let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
              value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
              return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
            },
          };
    const recording = new RecordingTraceSource(entropy);
    options.logCapture?.reset();
    try {
      await runScenario(recording);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lifecycleLines = options.logCapture?.lines();
      const dir = join(process.cwd(), "test-failures");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${options.name}-${Date.now()}-${i}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          {
            name: options.name,
            iteration: i,
            error: message,
            ...(lifecycleLines === undefined ? {} : { lifecycleLines: [...lifecycleLines] }),
            records: recording.getTrace(),
          },
          null,
          2,
        ),
      );
      // Prove the trace reproduces the failure before reporting it.
      let reproduced = false;
      try {
        options.logCapture?.reset();
        await runScenario(new ReplayingTraceSource(recording.getTrace()));
      } catch (replayError) {
        reproduced = failureIdentity(replayError) === failureIdentity(error);
      }
      throw new Error(
        `DST scenario "${options.name}" failed at iteration ${i} ` +
          `(trace: ${path}, replay ${reproduced ? "reproduces" : "DID NOT reproduce"} the failure): ${message}`,
        { cause: error },
      );
    }
    if (i + 1 < iterations) await setImmediate();
  }
}

/**
 * Poll `predicate` on virtual time until it holds. Fails the simulation task
 * if the condition never becomes true within `timeoutMs` virtual time.
 */
export async function waitUntil(
  task: SimulationTask,
  reason: string,
  predicate: () => boolean,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 500;
  const timeoutMs = options?.timeoutMs ?? 3_600_000;
  const deadline = task.monotonicNow() + timeoutMs;
  while (!predicate()) {
    if (task.monotonicNow() > deadline) {
      throw new Error(`waitUntil timed out: ${reason}`);
    }
    await task.sleep(intervalMs, `waitUntil: ${reason}`);
  }
}
