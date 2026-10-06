import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  kill: vi.fn(),
  write: vi.fn(),
  onData: undefined as undefined | ((chunk: string) => void),
  onExit: undefined as undefined | ((event: { exitCode: number }) => void),
  options: undefined as unknown,
  cleanupGate: undefined as Promise<void> | undefined,
  cleanupFailed: false,
  cleanupEntered: vi.fn(),
  cleanupFinished: undefined as (() => void) | undefined,
  groupAlive: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...native,
    rm: async (...args: Parameters<typeof native.rm>) => {
      state.cleanupEntered();
      await state.cleanupGate;
      await native.rm(...args);
      state.cleanupFinished?.();
      if (state.cleanupFailed) throw new Error("private scratch path");
    },
  };
});
vi.mock("node:process", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:process")>();
  return {
    ...native,
    kill: (pid: number, signal: string | number) => {
      expect(pid).toBe(-4242);
      if (signal === 0) {
        if (state.groupAlive) return true;
        throw Object.assign(new Error("test-owned group is gone"), { code: "ESRCH" });
      }
      return state.kill(signal);
    },
  };
});
vi.mock("node-pty", () => ({
  spawn: (_command: string, _args: string[], options: unknown) => {
    state.options = options;
    return {
      pid: 4242,
      kill: state.kill,
      write: state.write,
      onData: (f: typeof state.onData) => {
        state.onData = f;
      },
      onExit: (f: typeof state.onExit) => {
        state.onExit = f;
      },
    };
  },
}));

import { ClaudePtyAuthTransport } from "./claude-auth-pty.ts";

function cleanupStarted(): Promise<void> {
  return new Promise((resolve) => {
    state.cleanupEntered.mockImplementationOnce(resolve);
  });
}

it("never republishes submitted codes echoed by the PTY", async () => {
  const events: unknown[] = [];
  const started = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  state.onData?.("https://claude.com/cai/oauth/authorize?state=initial\n");
  started.sendCode("https://claude.com/cai/oauth/authorize?state=private-code");
  state.onData?.("https://claude.com/cai/oauth/authorize?state=private-code\n");
  expect(JSON.stringify(events)).not.toContain("private-code");
  started.cancel();
  state.onExit?.({ exitCode: 1 });
  await started.drain();
});

it("waits for native exit after submission, suppressing repeated prompts and raw errors", async () => {
  const events: unknown[] = [];
  const started = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  state.onData?.("Paste code here if prompted > ");
  expect(events).toEqual([{ challenge: { needsCode: true } }]);
  expect(started.sendCode("synthetic-completion-code").isOk()).toBe(true);
  state.onData?.("Invalid synthetic-completion-code\nPaste code here if prompted > ");
  expect(events).toEqual([{ challenge: { needsCode: true } }]);
  state.onExit?.({ exitCode: 1 });
  expect(events).toEqual([
    { challenge: { needsCode: true } },
    { error: "Claude sign-in failed", stage: "transport" },
  ]);
  expect(JSON.stringify(events)).not.toContain("synthetic-completion-code");
  await started.drain();
});

it("separates pasted code from Enter after a complete native masked redraw", async () => {
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  expect(session.sendCode("synthetic#state").isOk()).toBe(true);
  expect(state.write.mock.calls).toEqual([["\u001b[200~synthetic#state\u001b[201~"]]);
  state.onData?.("\u001b[32m*******");
  expect(state.write).toHaveBeenCalledTimes(1);
  state.onData?.("********\u001b[0m\u001b[31C\u001b[1A");
  expect(state.write.mock.calls).toEqual([["\u001b[200~synthetic#state\u001b[201~"], ["\r"]]);
  expect(events).toEqual([{ progress: "input_completed" }]);
  state.onData?.("***************");
  expect(state.write).toHaveBeenCalledTimes(2);
  state.onData?.("getaddrinfo EAI_AGAIN private-host\n");
  expect(events).toEqual([
    { progress: "input_completed" },
    { error: "Claude sign-in network request failed", stage: "native_exchange", reason: "network" },
  ]);
  expect(state.kill).toHaveBeenCalledTimes(1);
  state.onExit?.({ exitCode: 1 });
  await session.drain();
  expect(events).toHaveLength(2);
});

it("terminates the helper when the initial paste write fails", async () => {
  const session = (await new ClaudePtyAuthTransport().start(() => {}))._unsafeUnwrap();
  state.write.mockImplementationOnce(() => {
    throw new Error("private write error");
  });
  expect(session.sendCode("synthetic").isErr()).toBe(true);
  expect(state.kill).toHaveBeenCalledTimes(1);
  state.onExit?.({ exitCode: 1 });
  await session.drain();
});

it("reports a masked redraw write failure without throwing or waiting for timeout", async () => {
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  session.sendCode("synthetic");
  state.write.mockImplementationOnce(() => {
    throw new Error("private write error");
  });
  expect(() => state.onData?.("*********\u001b[31C\u001b[1A")).not.toThrow();
  expect(events).toEqual([{ error: "Claude sign-in input failed", stage: "native_input" }]);
  state.onExit?.({ exitCode: 1 });
  await session.drain();
});

it("ignores late native data after exit instead of reopening the challenge", async () => {
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  state.onExit?.({ exitCode: 1 });
  await session.drain();
  state.onData?.("Paste code here if prompted > ");
  expect(events).toEqual([{ error: "Claude sign-in failed", stage: "transport" }]);
});
it("does not equate wrapper exit with native process-group drain", async () => {
  vi.useFakeTimers();
  state.groupAlive = true;
  const session = (await new ClaudePtyAuthTransport().start(() => {}))._unsafeUnwrap();
  session.cancel();
  state.onExit?.({ exitCode: 1 });
  let finished = false;
  const pending = Promise.resolve(session.drain()).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(state.cleanupEntered).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  state.groupAlive = false;
  await vi.advanceTimersByTimeAsync(25);
  expect((await pending).isOk()).toBe(true);
  expect(state.cleanupEntered).toHaveBeenCalledTimes(1);
});
it("drain waits for exit and asynchronous scratch removal exactly once", async () => {
  let release!: () => void;
  state.cleanupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = (await new ClaudePtyAuthTransport().start(() => {}))._unsafeUnwrap();
  session.cancel();
  let finished = false;
  const pending = Promise.resolve(session.drain()).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(state.cleanupEntered).not.toHaveBeenCalled();
  const cleaning = cleanupStarted();
  state.onExit?.({ exitCode: 1 });
  await cleaning;
  expect(state.cleanupEntered).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  expect((await pending).isOk()).toBe(true);
  expect((await session.drain()).isOk()).toBe(true);
  session.cancel();
  expect(state.cleanupEntered).toHaveBeenCalledTimes(1);
  expect(state.kill).toHaveBeenCalledTimes(1);
});
it("withholds an issued token while cleanup is pending and drops it after cancellation", async () => {
  let release!: () => void;
  state.cleanupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  state.onData?.("Your OAuth token (valid for 1 year):\nsk-ant-oat01-synthetic-issued\n");
  state.onExit?.({ exitCode: 0 });
  expect(events).toEqual([]);
  session.cancel();
  release();
  expect((await session.drain()).isOk()).toBe(true);
  expect(events).toEqual([]);
});
it("bounds failed cleanup without ever publishing a token", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  state.cleanupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  state.onData?.("Your OAuth token (valid for 1 year):\nsk-ant-oat01-synthetic-issued\n");
  const cleaning = cleanupStarted();
  state.onExit?.({ exitCode: 0 });
  await cleaning;
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await session.drain())._unsafeUnwrapErr().stage).toBe("cleanup");
  expect(events).toEqual([{ error: "Claude sign-in cleanup failed", stage: "cleanup" }]);
  const cleaned = new Promise<void>((resolve) => {
    state.cleanupFinished = resolve;
  });
  release();
  await cleaned;
  expect(events).toEqual([{ error: "Claude sign-in cleanup failed", stage: "cleanup" }]);
});
it("drain returns typed cleanup failure after observed exit", async () => {
  state.cleanupFailed = true;
  const events: unknown[] = [];
  const session = (
    await new ClaudePtyAuthTransport().start((event) => events.push(event))
  )._unsafeUnwrap();
  session.cancel();
  state.onExit?.({ exitCode: 1 });
  expect((await session.drain()).isErr()).toBe(true);
  expect(events).toEqual([{ error: "Claude sign-in cleanup failed", stage: "cleanup" }]);
  expect(JSON.stringify(events)).not.toContain("private scratch path");
});
it("escalates termination and bounds unconfirmed exit without claiming cleanup", async () => {
  vi.useFakeTimers();
  const session = (await new ClaudePtyAuthTransport().start(() => {}))._unsafeUnwrap();
  session.cancel();
  const pending = session.drain();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.kill).toHaveBeenLastCalledWith("SIGKILL");
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await pending).isErr()).toBe(true);
  expect(state.cleanupEntered).not.toHaveBeenCalled();
  const cleaned = new Promise<void>((resolve) => {
    state.cleanupFinished = resolve;
  });
  state.onExit?.({ exitCode: 1 });
  await cleaned;
});
afterEach(async () => {
  state.cleanupGate = undefined;
  state.cleanupFailed = false;
  state.cleanupFinished = undefined;
  state.groupAlive = false;
  state.cleanupEntered.mockReset();
  vi.useRealTimers();
  state.kill.mockReset();
  state.write.mockReset();
});
it("contains child termination exceptions during timeout and excludes ambient config", async () => {
  vi.useFakeTimers();
  process.env["ANTHROPIC_API_KEY"] = "ambient-secret";
  const events: unknown[] = [];
  const started = await new ClaudePtyAuthTransport().start((event) => events.push(event));
  expect(started.isOk()).toBe(true);
  expect(JSON.stringify(state.options)).not.toContain("ambient-secret");
  state.kill.mockImplementation(() => {
    throw new Error("private-raw-error");
  });
  expect(() => vi.advanceTimersByTime(600_000)).not.toThrow();
  expect(events).toEqual([{ error: "Claude sign-in timed out", stage: "timeout" }]);
  state.onExit?.({ exitCode: 1 });
  await started._unsafeUnwrap().drain();
  delete process.env["ANTHROPIC_API_KEY"];
});
