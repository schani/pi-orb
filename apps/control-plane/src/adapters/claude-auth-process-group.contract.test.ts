import { execFile } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Result, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "--resistant",
  pid: 0,
  root: "",
  ready: undefined as undefined | ((value: Ownership) => void),
  outputComplete: undefined as undefined | (() => void),
  exited: undefined as undefined | (() => void),
  cleanup: undefined as undefined | (() => void),
  cleanupGate: Promise.resolve(),
  cleanupCalls: 0,
  groupLiveAtRemoval: false,
  signals: [] as string[],
  denyKill: false,
  rawRemove: undefined as undefined | typeof import("node:fs/promises").rm,
}));

type ProcessIdentity = { pid: number; ppid: number; pgid: number; sid: number };
type Ownership = { parent: ProcessIdentity; child: ProcessIdentity; networkDenied: boolean };
const evidence = resolve(".context/claude-production-hardening/auth/process-group-real-redgreen");
const fixture = fileURLToPath(new URL("./claude-auth-process-group.fixture.mjs", import.meta.url));
const nested = process.env["CLAUDE_AUTH_GROUP_NAMESPACE"] === "1";

// Only spawn, scratch ownership/removal, and signal-failure injection are interposed.
// The PTY, all PIDs, signals, and negative-PID kill(0) queries are genuine.
vi.mock("node-pty", async (importOriginal) => {
  const native = await importOriginal<typeof import("node-pty")>();
  return {
    ...native,
    spawn: (command: string, _args: string[], options: import("node-pty").IPtyForkOptions) => {
      const child = native.spawn(
        "/usr/bin/python3",
        [
          fileURLToPath(
            new URL("../../../../scripts/claude-sdk-contract/network-guard.py", import.meta.url),
          ),
          command,
          fixture,
          state.mode,
        ],
        { ...options, env: { ...options.env, NATIVE_CONTRACT_PORT: "-1" } },
      );
      state.pid = child.pid;
      state.root = options.cwd ?? "";
      let output = "";
      child.onData((chunk) => {
        output += chunk;
        const ready = /OWNED_READY (\{[^\r\n]+\})/.exec(output);
        if (ready?.[1]) state.ready?.(JSON.parse(ready[1]) as Ownership);
        if (output.includes("sk-ant-oat01-synthetic-group-only\r\n")) {
          state.outputComplete?.();
          output = "";
        }
      });
      child.onExit(() => state.exited?.());
      return child;
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:fs/promises")>();
  state.rawRemove = native.rm;
  return {
    ...native,
    mkdtemp: async () => {
      await native.mkdir(evidence, { recursive: true });
      return native.mkdtemp(join(evidence, "scratch-"));
    },
    rm: async (...args: Parameters<typeof native.rm>) => {
      expect(args[0]).toBe(state.root);
      state.cleanupCalls++;
      state.groupLiveAtRemoval = groupExists();
      state.cleanup?.();
      await state.cleanupGate;
      return native.rm(...args);
    },
  };
});
vi.mock("node:process", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:process")>();
  return {
    ...native,
    kill: (pid: number, signal: string | number) => {
      expect(pid).toBe(-state.pid);
      if (signal !== 0) {
        state.signals.push(String(signal));
        if (state.denyKill && signal === "SIGKILL")
          throw Object.assign(new Error("test-owned signal refusal"), { code: "EPERM" });
      }
      // Test-owned mutant proves a root-only exit query cannot satisfy the contract.
      if (signal === 0 && process.env["CLAUDE_AUTH_GROUP_MUTATION"] === "root-query")
        return native.kill(-pid, signal);
      return native.kill(pid, signal);
    },
  };
});

import type { ClaudeAuthEvent } from "../domain/claude-auth.ts";
import { ClaudePtyAuthTransport } from "./claude-auth-pty.ts";

// Saved native process.kill bypasses the fault injection for fixture teardown.
function probe(pid: number) {
  return Result.fromThrowable(
    () => process.kill(pid, 0),
    (cause) =>
      cause !== null && typeof cause === "object" && "code" in cause ? cause.code : "unknown",
  )();
}
function groupExists() {
  return probe(-state.pid).isOk();
}
function identity(pid: number): ProcessIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1];
  expect(stat).toBeDefined();
  const fields = (stat ?? "").split(" ");
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]) };
}
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function absent(pid: number) {
  // Real event-loop checkpoints, not sleeps or a guessed wall-clock deadline.
  while (probe(pid).isOk()) await new Promise<void>((done) => setImmediate(done));
  expect(probe(pid)._unsafeUnwrapErr()).toBe("ESRCH");
}

function transportClock() {
  const nativeTimeout = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { due: number; run: () => void }>();
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => {
    // Leave node-pty's 200ms close timer and setImmediate entirely native.
    if (![25, 5_000, 10_000, 600_000].includes(delay)) return nativeTimeout(run, delay);
    const handle = {} as ReturnType<typeof setTimeout>;
    timers.set(handle, { due: now + delay, run });
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (!timers.delete(handle as ReturnType<typeof setTimeout>)) nativeClear(handle);
  });
  return {
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, value]) => value.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].run();
      }
      now = target;
    },
    restore() {
      vi.restoreAllMocks();
    },
  };
}

if (!nested) {
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "qualifies auth SIGKILL and group quiescence in a disposable kernel network/PID namespace",
    async () => {
      await mkdir(evidence, { recursive: true });
      const ran = await ResultAsync.fromPromise(
        new Promise<string>((done, fail) => {
          execFile(
            process.execPath,
            [fixture, "--qualify"],
            { cwd: process.cwd() },
            (error, stdout, stderr) => {
              if (error) fail({ code: error.code, output: stdout + stderr });
              else done(stdout + stderr);
            },
          );
        }),
        (cause) => cause,
      );
      // Nested test output contains only synthetic inputs and sanitized assertions.
      expect(ran.isOk(), ran.isErr() ? JSON.stringify(ran.error) : "").toBe(true);
      expect(ran._unsafeUnwrap()).toContain("3 passed");
    },
  );
} else {
  it.each([
    { mode: "--resistant", name: "kills a SIGTERM-resistant wrapper and its actual descendants" },
    {
      mode: "--root-first",
      name: "does not drain or remove scratch when the root exits before its child",
    },
    {
      mode: "--root-first",
      name: "returns typed exit uncertainty while an actual owned group remains",
      denyKill: true,
    },
  ])("$name", async ({ mode, denyKill = false }) => {
    state.mode = mode;
    state.pid = 0;
    state.root = "";
    state.signals = [];
    state.cleanupCalls = 0;
    state.groupLiveAtRemoval = false;
    state.denyKill = denyKill;
    const ready = barrier<Ownership>();
    const outputComplete = barrier();
    const exited = barrier();
    const cleaning = barrier();
    const releaseCleanup = barrier();
    state.ready = ready.resolve;
    state.outputComplete = outputComplete.resolve;
    state.exited = exited.resolve;
    state.cleanup = cleaning.resolve;
    state.cleanupGate = releaseCleanup.promise;
    const clock = transportClock();
    const events: ClaudeAuthEvent[] = [];
    let tokenSeen = false;
    let challengeSeen = false;
    let drainFinished = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const session = (
      await new ClaudePtyAuthTransport().start((event) => {
        if ("token" in event) tokenSeen = true;
        else if ("challenge" in event) challengeSeen = true;
        else events.push(event);
      })
    )._unsafeUnwrap();
    try {
      const ownership = await ready.promise;
      await outputComplete.promise;
      expect(ownership.networkDenied).toBe(true);
      const root = identity(state.pid);
      expect(root.pgid).toBe(state.pid);
      expect(root.sid).toBe(state.pid);
      expect(root.pgid).not.toBe(identity(process.pid).pgid);
      expect(root.pid).toBeGreaterThan(1);
      for (const owned of [ownership.parent, ownership.child]) {
        expect(identity(owned.pid)).toEqual(owned);
        expect(owned.pgid).toBe(root.pid);
        expect(owned.sid).toBe(root.pid);
      }
      expect(ownership.parent.ppid).toBe(root.pid);
      expect(ownership.child.ppid).toBe(ownership.parent.pid);
      expect(groupExists()).toBe(true);
      const termObserved = barrier();
      watcher = watch(state.root, (_event, name) => {
        if (String(name) === "child-term") termObserved.resolve();
      });
      const pending = Promise.resolve(session.drain()).then((result) => {
        drainFinished = true;
        return result;
      });
      expect(session.cancel().isOk()).toBe(true);
      await termObserved.promise;
      expect(await readFile(join(state.root, "child-term"), "utf8")).toBe("observed");
      if (mode === "--root-first") {
        await exited.promise;
        await absent(root.pid);
        await absent(ownership.parent.pid);
        expect(probe(ownership.child.pid).isOk()).toBe(true);
      }
      expect(groupExists()).toBe(true);
      expect(drainFinished).toBe(false);
      expect(state.cleanupCalls).toBe(0);
      expect(existsSync(state.root)).toBe(true);
      clock.advance(4_999);
      expect(state.signals).toEqual(["SIGTERM"]);
      expect(drainFinished).toBe(false);
      clock.advance(1);
      expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
      if (denyKill) {
        expect(groupExists()).toBe(true);
        clock.advance(5_000);
        const result = await pending;
        expect(result._unsafeUnwrapErr()).toEqual({
          code: "unavailable",
          message: "Claude sign-in unavailable",
          stage: "exit",
        });
        expect(state.cleanupCalls).toBe(0);
        expect(existsSync(state.root)).toBe(true);
        expect(events).toEqual([
          { error: "Claude sign-in exit could not be confirmed", stage: "exit" },
        ]);
      } else {
        await exited.promise;
        await absent(-root.pid);
        for (const pid of [root.pid, ownership.parent.pid, ownership.child.pid]) await absent(pid);
        clock.advance(25);
        await cleaning.promise;
        expect(state.groupLiveAtRemoval).toBe(false);
        expect(state.cleanupCalls).toBe(1);
        expect(drainFinished).toBe(false);
        expect(existsSync(state.root)).toBe(true);
        releaseCleanup.resolve();
        expect((await pending).isOk()).toBe(true);
        expect((await session.drain()).isOk()).toBe(true);
        expect(existsSync(state.root)).toBe(false);
        expect(events).toEqual([]);
      }
      expect(challengeSeen).toBe(true);
      expect(tokenSeen).toBe(false);
      expect(JSON.stringify(events)).not.toContain("synthetic-group-only");
      console.info(
        JSON.stringify({
          qualification: "claude-auth-process-group",
          rootExitedBeforeChild: mode === "--root-first",
          kernelNetworkDenied: ownership.networkDenied,
          sigtermObserved: true,
          sigkillRequested: state.signals.includes("SIGKILL"),
          signalRefused: denyKill,
          exitObserved: true,
          groupGone: !groupExists(),
          scratchRemoved: !existsSync(state.root),
          drained: !denyKill,
          stage: denyKill ? "exit" : undefined,
          drainFinished,
          tokenPublished: tokenSeen,
        }),
      );
    } finally {
      watcher?.close();
      releaseCleanup.resolve();
      // This PID came only from forkpty, never from user input or a managed service.
      if (state.pid > 1 && groupExists()) {
        const terminated = Result.fromThrowable(
          () => process.kill(-state.pid, "SIGKILL"),
          () => "cleanup failed",
        )();
        expect(terminated.isOk()).toBe(true);
        await absent(-state.pid);
      }
      clock.restore();
      expect(resolve(state.root).startsWith(`${evidence}/scratch-`)).toBe(true);
      await state.rawRemove?.(state.root, { recursive: true, force: true });
    }
  });
}
