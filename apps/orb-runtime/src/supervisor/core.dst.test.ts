import type { SimulationTask } from "determined";
import { ok, okAsync, ResultAsync, type ResultAsync as ResultAsyncType } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  type ChildExit,
  type Health,
  type SupervisorError,
  type SupervisorPorts,
  supervise,
} from "./core.ts";

interface Shared {
  exit: ChildExit | null;
  handler?: (signal: NodeJS.Signals) => void;
  forwarded: NodeJS.Signals[];
  reports: Array<{
    status: "ready" | "failed";
    code?: string;
    details?: object;
    exitAtReport: ChildExit | null;
  }>;
  exitWaiters: Array<(exit: ChildExit) => void>;
  readonly reported: Promise<void>;
  resolveReported(): void;
}

class SimPorts implements SupervisorPorts<{ pid: number }> {
  protected readonly task: SimulationTask;
  protected readonly shared: Shared;
  constructor(task: SimulationTask, shared: Shared) {
    this.task = task;
    this.shared = shared;
  }
  installSignalHandlers(handler: (signal: NodeJS.Signals) => void) {
    this.shared.handler = handler;
    return ok(undefined);
  }
  spawn() {
    return ok({ pid: 123 });
  }
  poll() {
    return this.shared.exit === null ? null : ok(this.shared.exit);
  }
  wait(): ResultAsyncType<ChildExit, SupervisorError> {
    if (this.shared.exit !== null) return okAsync(this.shared.exit);
    return ResultAsync.fromSafePromise(
      new Promise<ChildExit>((resolve) => this.shared.exitWaiters.push(resolve)),
    );
  }
  forward(_child: { pid: number }, signal: NodeJS.Signals) {
    this.shared.forwarded.push(signal);
    return ok(undefined);
  }
  health(): ResultAsyncType<Health, SupervisorError> {
    return ResultAsync.fromPromise(
      (async () => {
        await this.task.checkpoint("simulated health response");
        await this.task.failpoint("runtime-supervisor-health-failure");
        return { status: "ready" } as const;
      })(),
      (cause) => ({ type: "health_failed", message: String(cause) }),
    );
  }
  sleep(): ResultAsyncType<void, SupervisorError> {
    return ResultAsync.fromSafePromise(this.task.checkpoint("simulated health retry"));
  }
  report(
    status: "ready" | "failed",
    code?: string,
    details?: object,
  ): ResultAsyncType<void, SupervisorError> {
    this.shared.reports.push({
      status,
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
      exitAtReport: this.shared.exit,
    });
    this.shared.resolveReported();
    return ResultAsync.fromPromise(
      this.task.failpoint("runtime-supervisor-diagnostic-failure"),
      (cause) => ({ type: "diagnostic_failed", message: String(cause) }),
    );
  }
  logDiagnosticFailure() {}
}

describe("runtime supervisor scheduling", () => {
  it("orders health, child exit, shutdown, and diagnostic failure safely", async () => {
    await runDst(
      {
        name: "runtime-supervisor-races",
        iterations: 100,
        failpointProbabilities: {
          "runtime-supervisor-health-failure": 0.2,
          "runtime-supervisor-diagnostic-failure": 0.2,
        },
      },
      async (sim) => {
        let resolveReported: () => void = () => undefined;
        const reported = new Promise<void>((resolve) => {
          resolveReported = resolve;
        });
        const shared: Shared = {
          exit: null,
          forwarded: [],
          reports: [],
          exitWaiters: [],
          reported,
          resolveReported,
        };
        const results = await sim.runTasks([
          {
            name: "supervisor",
            f: (task) => supervise(task, new SimPorts(task, shared)),
          },
          {
            name: "runtime-events",
            f: async (task) => {
              await task.checkpoint("before shutdown signal");
              shared.handler?.("SIGTERM");
              await task.checkpoint("before child exit");
              shared.exit = { type: "exit", code: 19 };
              for (const waiter of shared.exitWaiters) waiter(shared.exit);
              await task.checkpoint("after child exit");
              shared.handler?.("SIGINT");
            },
          },
        ]);
        expect(results.isOk()).toBe(true);
        if (results.isErr()) return;
        const supervisor = results.value[0];
        expect(supervisor?.isOk()).toBe(true);
        if (supervisor?.isOk()) expect(supervisor.value).toEqual({ type: "exit", code: 19 });
        expect(shared.reports).toHaveLength(1);
        const report = shared.reports[0];
        if (report?.status === "ready") expect(report.exitAtReport).toBeNull();
        else
          expect(report).toEqual({
            status: "failed",
            code: "runtime_exited_before_ready",
            details: { exitCode: 19 },
            exitAtReport: { type: "exit", code: 19 },
          });
        expect(shared.forwarded.filter((signal) => signal === "SIGINT")).toHaveLength(0);
      },
    );
  });

  it("permits initialization beyond ten minutes and preserves typed failed health", async () => {
    await runDst(
      { name: "runtime-supervisor-unbounded-readiness", iterations: 20 },
      async (sim) => {
        let resolveReported: () => void = () => undefined;
        const reported = new Promise<void>((resolve) => {
          resolveReported = resolve;
        });
        const shared: Shared = {
          exit: null,
          forwarded: [],
          reports: [],
          exitWaiters: [],
          reported,
          resolveReported,
        };
        class LongBootPorts extends SimPorts {
          health(): ResultAsyncType<Health, SupervisorError> {
            return okAsync(
              this.task.monotonicNow() < 601_000
                ? { status: "initializing" }
                : { status: "failed", code: "clone_failed" },
            );
          }
          sleep(): ResultAsyncType<void, SupervisorError> {
            return ResultAsync.fromPromise(
              this.task.sleep(1_000, "long runtime initialization"),
              (cause) => ({ type: "sleep_failed", message: String(cause) }),
            );
          }
        }
        const results = await sim.runTasks([
          {
            name: "supervisor",
            f: (task: SimulationTask) => supervise(task, new LongBootPorts(task, shared)),
          },
          {
            name: "runtime-exit",
            f: async () => {
              await shared.reported;
              shared.exit = { type: "exit", code: 37 };
              for (const waiter of shared.exitWaiters) waiter(shared.exit);
            },
          },
        ]);
        expect(results.isOk()).toBe(true);
        if (results.isErr()) return;
        expect(results.value[0]?._unsafeUnwrap()).toEqual({ type: "exit", code: 37 });
        expect(shared.reports).toEqual([
          { status: "failed", code: "clone_failed", exitAtReport: null },
        ]);
      },
    );
  });
});
