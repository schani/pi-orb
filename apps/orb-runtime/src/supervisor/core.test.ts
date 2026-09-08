import { NoSimulationTask } from "determined";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  type ChildExit,
  type Health,
  type SupervisorError,
  type SupervisorPorts,
  supervise,
} from "./core.ts";

interface Child {
  readonly pid: number;
}

class FakePorts implements SupervisorPorts<Child> {
  readonly child = { pid: 123 };
  readonly reports: Array<{ status: "ready" | "failed"; code?: string; details?: object }> = [];
  readonly forwarded: NodeJS.Signals[] = [];
  healthResults: Array<Result<Health, SupervisorError>> = [ok({ status: "ready" })];
  exit: ChildExit | null = null;
  waitedExit: ChildExit = { type: "exit", code: 0 };
  sleeps = 0;
  reportFails = false;
  signalHandler: ((signal: NodeJS.Signals) => void) | undefined;

  installSignalHandlers(handler: (signal: NodeJS.Signals) => void) {
    this.signalHandler = handler;
    return ok(undefined);
  }
  spawn() {
    return ok(this.child);
  }
  poll() {
    return this.exit === null ? null : ok(this.exit);
  }
  wait(): ResultAsyncType<ChildExit, SupervisorError> {
    return okAsync(this.waitedExit);
  }
  forward(_child: Child, signal: NodeJS.Signals) {
    this.forwarded.push(signal);
    return ok(undefined);
  }
  health(): ResultAsyncType<Health, SupervisorError> {
    const result = this.healthResults.shift() ?? ok<Health>({ status: "initializing" });
    return result.isOk() ? okAsync(result.value) : errAsync(result.error);
  }
  sleep(): ResultAsyncType<void, SupervisorError> {
    this.sleeps += 1;
    return okAsync(undefined);
  }
  report(status: "ready" | "failed", code?: string, details?: object) {
    this.reports.push({
      status,
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
    });
    return this.reportFails
      ? errAsync<void, SupervisorError>({ type: "diagnostic_failed", message: "unavailable" })
      : okAsync(undefined);
  }
  logDiagnosticFailure() {}
}

describe("runtime supervisor", () => {
  it("publishes ready once and waits for the child", async () => {
    const ports = new FakePorts();
    ports.waitedExit = { type: "exit", code: 17 };
    const result = await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(result._unsafeUnwrap()).toEqual({ type: "exit", code: 17 });
    expect(ports.reports).toEqual([{ status: "ready" }]);
  });

  it("has no readiness deadline and retries bad or initializing health", async () => {
    const ports = new FakePorts();
    ports.healthResults = [
      ...Array.from({ length: 601 }, () => ok<Health>({ status: "initializing" })),
      err<Health, SupervisorError>({ type: "health_failed", message: "bad json" }),
      ok({ status: "ready" }),
    ];
    const result = await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(result.isOk()).toBe(true);
    expect(ports.sleeps).toBe(602);
  });

  it("publishes bounded typed failure and stays alive until the child exits", async () => {
    const ports = new FakePorts();
    ports.healthResults = [ok({ status: "failed", code: "clone_failed" })];
    ports.waitedExit = { type: "signal", signal: "SIGABRT", number: 6 };
    const result = await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(result._unsafeUnwrap()).toEqual({ type: "signal", signal: "SIGABRT", number: 6 });
    expect(ports.reports).toEqual([{ status: "failed", code: "clone_failed" }]);
  });

  it.each(["ready", "failed"] as const)(
    "does not finish after terminal %s health until the child exits",
    async (status) => {
      const ports = new FakePorts();
      ports.healthResults = [
        status === "ready"
          ? ok({ status: "ready" })
          : ok({ status: "failed", code: "clone_failed" }),
      ];
      let release: ((exit: ChildExit) => void) | undefined;
      ports.wait = () =>
        new ResultAsync(
          new Promise<Result<ChildExit, SupervisorError>>((resolve) => {
            release = (exit) => resolve(ok(exit));
          }),
        );
      let settled = false;
      const running = supervise(new NoSimulationTask("supervisor test", false), ports).then(
        (result) => {
          settled = true;
          return result;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release?.({ type: "exit", code: 29 });
      expect((await running)._unsafeUnwrap()).toEqual({ type: "exit", code: 29 });
    },
  );

  it.each([
    [{ type: "exit", code: 23 } satisfies ChildExit, { exitCode: 23 }],
    [{ type: "signal", signal: "SIGKILL", number: 9 } satisfies ChildExit, { signal: 9 }],
  ])("reports an early child exit", async (exit, details) => {
    const ports = new FakePorts();
    ports.exit = exit;
    const result = await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(result._unsafeUnwrap()).toEqual(exit);
    expect(ports.reports).toEqual([
      { status: "failed", code: "runtime_exited_before_ready", details },
    ]);
  });

  it("checks child exit after health and before publishing readiness", async () => {
    const ports = new FakePorts();
    ports.health = () => {
      ports.exit = { type: "exit", code: 7 };
      return okAsync({ status: "ready" });
    };
    await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(ports.reports).toEqual([
      { status: "failed", code: "runtime_exited_before_ready", details: { exitCode: 7 } },
    ]);
  });

  it("preserves the child outcome when diagnostic publication fails", async () => {
    const ports = new FakePorts();
    ports.exit = { type: "exit", code: 31 };
    ports.reportFails = true;
    const result = await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(result._unsafeUnwrap()).toEqual({ type: "exit", code: 31 });
  });

  it("forwards TERM and INT and checks current child state before every signal", async () => {
    const ports = new FakePorts();
    ports.health = () => {
      ports.signalHandler?.("SIGTERM");
      ports.signalHandler?.("SIGINT");
      ports.exit = { type: "exit", code: 0 };
      ports.signalHandler?.("SIGTERM");
      return okAsync({ status: "ready" });
    };
    await supervise(new NoSimulationTask("supervisor test", false), ports);
    expect(ports.forwarded).toEqual(["SIGTERM", "SIGINT"]);
  });
});
