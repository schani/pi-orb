import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EntropySource,
  type Logger,
  type PendingTimerView,
  RecordingTraceSource,
  ReplayingTraceSource,
  SimpleEntropySource,
  type Simulation,
  SimulationImpl,
} from "determined";

/**
 * Minimal DST runner for orb-runtime domain tests; mirrors the control
 * plane's testkit/sim.ts (workspaces cannot import each other's testkits).
 */

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

export interface DstOptions {
  readonly name: string;
  readonly iterations?: number;
  readonly failpointProbabilities?: Readonly<Record<string, number>>;
}

/** Fixed epoch so wall-clock assertions are stable: 2026-01-01T00:00:00Z. */
export const TEST_WALL_EPOCH = 1_767_225_600_000;

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

function makeSimulation(options: DstOptions, entropy: EntropySource): SimulationImpl {
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
      wallClockEpoch: TEST_WALL_EPOCH,
      maxSchedulingSteps: 200_000,
      maxVirtualDurationMs: 24 * 3_600_000,
      failOnLateCompletion: false,
      pickTimerIndex: pickTimerBiasedEarliest,
    },
  );
}

/**
 * Runs `scenario` under many recorded entropy schedules; failing traces are
 * saved to `test-failures/`, replay-verified, and rethrown with the path.
 * Set `DST_REPLAY` to a saved trace file to re-run only that schedule.
 */
export async function runDst(
  options: DstOptions,
  scenario: (sim: Simulation) => Promise<void>,
): Promise<void> {
  const replayPath = process.env["DST_REPLAY"];
  if (replayPath !== undefined && replayPath !== "") {
    const { readFileSync } = await import("node:fs");
    const trace = JSON.parse(readFileSync(replayPath, "utf8"));
    await scenario(makeSimulation(options, new ReplayingTraceSource(trace.records)));
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
      let reproduced = false;
      try {
        await scenario(makeSimulation(options, new ReplayingTraceSource(recording.getTrace())));
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
