import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  type PtyFactory,
  type PtyProcess,
  TerminalManager,
  type TerminalProcessExit,
} from "./manager.ts";

class FakeProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(exit: TerminalProcessExit) => void>();

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.exit({ exitCode: 0, signal: 15 });
  }
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exit: TerminalProcessExit): void {
    for (const listener of [...this.exitListeners]) listener(exit);
  }
}

describe("TerminalManager", () => {
  it("spawns, resizes, and exits a real node-pty shell", async () => {
    const manager = new TerminalManager({ cwd: process.cwd(), maxSessions: 1 });
    const opened = await manager.open(80, 24);
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    let output = "";
    expect(
      opened.value
        .onData((data) => {
          output += data;
        })
        .isOk(),
    ).toBe(true);
    const exited = new Promise<TerminalProcessExit>((resolve) => {
      expect(opened.value.onExit(resolve).isOk()).toBe(true);
    });
    expect(opened.value.resize(132, 41).isOk()).toBe(true);
    expect(
      opened.value.write("stty size; printf '<%s>' \"$PS1\"; printf NODE_PTY_OK; exit 7\r").isOk(),
    ).toBe(true);
    const result = await exited;
    expect(output).toContain("41 132");
    expect(output).toContain("<# >");
    expect(output).toContain("NODE_PTY_OK");
    expect(result.exitCode).toBe(7);
    expect(manager.activeCount).toBe(0);
  });

  it("enforces the session limit and releases capacity after exit", async () => {
    const processes: FakeProcess[] = [];
    const factory: PtyFactory = {
      open: () => {
        const process = new FakeProcess();
        processes.push(process);
        return okAsync(process);
      },
    };
    const manager = new TerminalManager({ cwd: "/repo", maxSessions: 1, factory });

    const first = await manager.open(80, 24);
    expect(first.isOk()).toBe(true);
    const blocked = await manager.open(80, 24);
    expect(blocked.isErr() && blocked.error.code).toBe("limit_reached");

    processes[0]?.exit({ exitCode: 0, signal: 0 });
    const second = await manager.open(100, 30);
    expect(second.isOk()).toBe(true);
  });

  it("closes every active PTY and rejects later opens during shutdown", async () => {
    const processes: FakeProcess[] = [];
    const factory: PtyFactory = {
      open: () => {
        const process = new FakeProcess();
        processes.push(process);
        return okAsync(process);
      },
    };
    const manager = new TerminalManager({ cwd: "/repo", maxSessions: 2, factory });
    await manager.open(80, 24);
    await manager.open(80, 24);

    manager.closeAll();
    expect(processes.map((process) => process.killed)).toEqual([true, true]);
    const after = await manager.open(80, 24);
    expect(after.isErr() && after.error.code).toBe("pty_unavailable");
  });

  it("releases a reservation when PTY creation fails", async () => {
    let attempts = 0;
    const factory: PtyFactory = {
      open: () => {
        attempts += 1;
        return attempts === 1
          ? errAsync({ code: "pty_failed" as const, message: "spawn failed", retryable: true })
          : okAsync(new FakeProcess());
      },
    };
    const manager = new TerminalManager({ cwd: "/repo", maxSessions: 1, factory });
    expect((await manager.open(80, 24)).isErr()).toBe(true);
    expect((await manager.open(80, 24)).isOk()).toBe(true);
  });
});
