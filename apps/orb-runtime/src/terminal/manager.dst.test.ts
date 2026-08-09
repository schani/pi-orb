import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  type PtyFactory,
  type PtyProcess,
  TerminalManager,
  type TerminalProcessExit,
} from "./manager.ts";

class ScheduledProcess implements PtyProcess {
  private exitListeners = new Set<(exit: TerminalProcessExit) => void>();
  write(): void {}
  resize(): void {}
  kill(): void {
    this.exit();
  }
  onData(): () => void {
    return () => undefined;
  }
  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  exit(): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode: 0, signal: 0 });
  }
}

describe("terminal admission DST", () => {
  it("never exceeds capacity while concurrent PTY opens cross scheduling checkpoints", async () => {
    await runDst({ name: "terminal-admission", iterations: 40 }, async (sim) => {
      const run = await sim.runTasks([
        {
          name: "scenario",
          f: async (task) => {
            const processes: ScheduledProcess[] = [];
            const factory: PtyFactory = {
              open: () =>
                ResultAsync.fromSafePromise(
                  task.checkpoint("pty factory open").then(() => {
                    const process = new ScheduledProcess();
                    processes.push(process);
                    return process;
                  }),
                ),
            };
            const manager = new TerminalManager({ cwd: "/repo", maxSessions: 1, factory });
            const [a, b] = await Promise.all([manager.open(80, 24), manager.open(100, 30)]);
            expect([a, b].filter((result) => result.isOk())).toHaveLength(1);
            expect(manager.activeCount).toBe(1);
            processes[0]?.exit();
            await task.checkpoint("terminal exited");
            expect(manager.activeCount).toBe(0);
            expect((await manager.open(120, 40)).isOk()).toBe(true);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });
});
