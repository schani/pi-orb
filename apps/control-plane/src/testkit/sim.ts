import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RecordingTraceSource,
  ReplayingTraceSource,
  SimpleEntropySource,
  SimulationImpl,
  type EntropySource,
  type Logger,
  type PendingTimerView,
  type Simulation,
  type SimulationTask,
} from "determined";

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

export interface DstOptions {
  readonly name: string;
  readonly iterations?: number;
  /** Failure probability per failpoint name; unnamed failpoints never fire. */
  readonly failpointProbabilities?: Readonly<Record<string, number>>;
  readonly maxSchedulingSteps?: number;
  readonly maxVirtualDurationMs?: number;
  readonly wallClockEpoch?: number;
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
): number {
  let earliest = 0;
  for (let i = 1; i < timers.length; i++) {
    const timer = timers[i];
    const current = timers[earliest];
    if (timer !== undefined && current !== undefined && timer.deadline < current.deadline) {
      earliest = i;
    }
  }
  if (random("timer pick: explore late firing") < 0.05) {
    return Math.floor(random("timer pick: index") * timers.length);
  }
  return earliest;
}

export function makeSimulation(options: DstOptions, entropy: EntropySource): SimulationImpl {
  const probabilities = options.failpointProbabilities ?? {};
  return new SimulationImpl(
    silentLogger,
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
      pickTimerIndex: pickTimerBiasedEarliest,
    },
  );
}

/** A fresh recording simulation with the standard test options (for multi-phase scenarios). */
export function makeRecordingSimulation(options: DstOptions): SimulationImpl {
  return makeSimulation(options, new RecordingTraceSource(new SimpleEntropySource()));
}

/**
 * Runs `scenario` under many recorded entropy schedules. On failure the full
 * trace is saved to `test-failures/`, replayed once to prove the failure
 * reproduces, and rethrown with the trace path. Set the `DST_REPLAY`
 * environment variable to a saved trace file to re-run only that schedule.
 */
export async function runDst(
  options: DstOptions,
  scenario: (sim: Simulation) => Promise<void>,
): Promise<void> {
  const replayPath = process.env["DST_REPLAY"];
  if (replayPath !== undefined && replayPath !== "") {
    const { readFileSync } = await import("node:fs");
    const trace = JSON.parse(readFileSync(replayPath, "utf8"));
    const replaySim = makeSimulation(options, new ReplayingTraceSource(trace.records));
    await scenario(replaySim);
    return;
  }

  const iterations = options.iterations ?? 30;
  for (let i = 0; i < iterations; i++) {
    const recording = new RecordingTraceSource(new SimpleEntropySource());
    const sim = makeSimulation(options, recording);
    try {
      await scenario(sim);
    } catch (error) {
      const dir = join(process.cwd(), "test-failures");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${options.name}-${Date.now()}-${i}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          { name: options.name, iteration: i, records: recording.getTrace() },
          null,
          2,
        ),
      );
      // Prove the trace reproduces the failure before reporting it.
      let reproduced = false;
      try {
        const replaySim = makeSimulation(options, new ReplayingTraceSource(recording.getTrace()));
        await scenario(replaySim);
      } catch {
        reproduced = true;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DST scenario "${options.name}" failed at iteration ${i} ` +
          `(trace: ${path}, replay ${reproduced ? "reproduces" : "DID NOT reproduce"} the failure): ${message}`,
        { cause: error },
      );
    }
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
