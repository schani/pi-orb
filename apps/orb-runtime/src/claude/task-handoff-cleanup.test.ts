import { EventEmitter, once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  query: vi.fn(),
  closed: false,
  earlyRemoval: false,
}));
beforeEach(() => {
  fixture.closed = false;
  fixture.earlyRemoval = false;
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: fixture.spawn,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fixture.query }));

vi.mock("node:http", () => ({
  createServer: () =>
    Object.assign(new EventEmitter(), {
      listen(this: EventEmitter) {
        queueMicrotask(() => this.emit("listening"));
      },
      address: () => ({ port: 1234 }),
      closeAllConnections() {},
      close(done: () => void) {
        done();
      },
    }),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) =>
      args[0].toString().startsWith("/proc/")
        ? Promise.resolve("123456789 (fixture) S 1 123456789")
        : fs.readFile(...args),
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0].toString().endsWith("gate1") && !fixture.closed) fixture.earlyRemoval = true;
      return fs.rm(...args);
    },
  };
});

it("joins native close before removing gates or settling an onMessage failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-cleanup-"));
  const child = Object.assign(new EventEmitter(), { pid: 123456789, stderr: { resume() {} } });
  fixture.spawn.mockReturnValue(child);
  fixture.query.mockImplementation(({ options }) => {
    options.spawnClaudeCodeProcess({ command: "unused", args: [], env: {}, cwd: root });
    return {
      accountInfo: async () => ({}),
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: "synthetic" };
      },
    };
  });
  const spy = vi.spyOn(process, "kill").mockImplementation(() => {
    setImmediate(() => {
      fixture.closed = true;
      child.emit("close", 137, "SIGKILL");
    });
    return true;
  });
  try {
    const { probeTaskHandoff } = await import(
      "../../../../scripts/claude-sdk-contract/task-handoff.mjs"
    );
    const result = probeTaskHandoff({
      cwd: root,
      configDir: join(root, "config"),
      sessionId: "fixture",
      release: "after-result",
      input: {
        type: "user",
        message: { role: "user", content: "fixture" },
        parent_tool_use_id: null,
      },
      onMessage: async () => {
        throw new Error("controlled onMessage failure");
      },
    });
    await expect(result).rejects.toThrow("controlled onMessage failure");
    expect(fixture.earlyRemoval).toBe(false);
    expect(fixture.closed).toBe(true);
    await expect(access(join(root, "gate1"))).rejects.toThrow();
  } finally {
    child.emit("close", 137, "SIGKILL");
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["exit", "error", "deadline", "iterator"] as const)(
  "cleans up a missing continuation on %s without releasing native close ownership",
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), "handoff-missing-continuation-"));
    const child = Object.assign(new EventEmitter(), {
      pid: 123456789,
      stdout: new EventEmitter(),
      stderr: { resume() {} },
    });
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let home: string | undefined;
    fixture.spawn.mockReturnValue(child);
    fixture.query.mockImplementation(({ options }) => {
      home = options.env.HOME;
      options.spawnClaudeCodeProcess({ command: "unused", args: [], env: {}, cwd: root });
      return {
        accountInfo: async () => ({}),
        close() {},
        async *[Symbol.asyncIterator]() {
          enter();
          if (fault === "iterator") throw new Error("controlled iterator failure");
          yield { type: "result", subtype: "success", is_error: true, num_turns: 1 };
        },
      };
    });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      return true;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    try {
      const { probeTaskHandoff } = await import(
        "../../../../scripts/claude-sdk-contract/task-handoff.mjs"
      );
      const onMessage = vi.fn(async () => false);
      const result = probeTaskHandoff({
        cwd: root,
        configDir: join(root, "config"),
        sessionId: "fixture",
        release: "during-response",
        terminalFailure: true,
        input: {
          type: "user",
          message: { role: "user", content: "fixture" },
          parent_tool_use_id: null,
        },
        onMessage,
      });
      const outcome = result.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await entered;
      await new Promise<void>(setImmediate);
      if (fault === "exit") child.emit("exit", 1, null);
      else if (fault === "error") child.emit("error", new Error("controlled native failure"));
      else if (fault === "deadline") await vi.advanceTimersByTimeAsync(20_000);
      await new Promise<void>(setImmediate);
      expect(settled).toBe(false);
      await expect(access(join(root, "gate1"))).resolves.toBeUndefined();
      // Exit/error/deadline must enter finally, but cleanup still belongs to native close.
      expect(spy).toHaveBeenCalled();
      fixture.closed = true;
      child.emit("close", 1, null);
      expect(await outcome).toEqual(
        expect.objectContaining({
          message:
            fault === "deadline"
              ? "Native task-handoff deadline expired."
              : fault === "iterator"
                ? "controlled iterator failure"
                : fault === "error"
                  ? "controlled native failure"
                  : "Native exited before requesting the continuation.",
        }),
      );
      expect(onMessage).not.toHaveBeenCalled();
      expect(fixture.earlyRemoval).toBe(false);
      expect(settled).toBe(true);
      for (const gate of ["gate1", "gate2"])
        await expect(access(join(root, gate))).rejects.toThrow();
      if (home !== undefined) await expect(access(home)).rejects.toThrow();
    } finally {
      fixture.closed = true;
      child.emit("close", 1, null);
      vi.useRealTimers();
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
      if (home !== undefined) await rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "releases and joins detached Bash FIFO readers after a native producer failure",
  async () => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { readFile } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "handoff-detached-readers-"));
    const readers: ReturnType<typeof spawn>[] = [];
    const outputs = ["", ""];
    const child = Object.assign(new EventEmitter(), {
      pid: 123456789,
      stderr: { resume() {} },
    });
    fixture.spawn.mockReturnValue(child);
    fixture.query.mockImplementation(({ options }) => {
      options.spawnClaudeCodeProcess({ command: "unused", args: [], env: {}, cwd: root });
      return {
        accountInfo: async () => ({}),
        close() {},
        async *[Symbol.asyncIterator]() {
          for (const [i, gate] of ["gate1", "gate2"].entries()) {
            const reader = spawn(
              "/bin/bash",
              ["-c", 'exec cat "$1"', "fixture", join(root, gate)],
              {
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            readers.push(reader);
            reader.stdout?.on("data", (data) => {
              outputs[i] += String(data);
            });
            reader.stderr?.resume();
            while ((await readFile(`/proc/${reader.pid}/wchan`, "utf8")) !== "wait_for_partner")
              await new Promise<void>(setImmediate);
          }
          yield { type: "synthetic" };
        },
      };
    });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      queueMicrotask(() => {
        fixture.closed = true;
        child.emit("close", 137, "SIGKILL");
      });
      return true;
    });
    try {
      const { probeTaskHandoff } = await import(
        "../../../../scripts/claude-sdk-contract/task-handoff.mjs"
      );
      await expect(
        probeTaskHandoff({
          cwd: root,
          configDir: join(root, "config"),
          sessionId: "fixture",
          release: "after-result",
          input: {
            type: "user",
            message: { role: "user", content: "fixture" },
            parent_tool_use_id: null,
          },
          onMessage: async () => {
            throw new Error("controlled producer failure");
          },
        }),
      ).rejects.toThrow("controlled producer failure");
      for (const reader of readers) {
        if (reader.exitCode === null)
          await once(reader, "close", { signal: AbortSignal.timeout(20_000) });
        expect(reader.exitCode).toBe(0);
      }
      expect(outputs).toEqual(["done\n", "done\n"]);
      expect(fixture.earlyRemoval).toBe(false);
      for (const gate of ["gate1", "gate2"])
        await expect(access(join(root, gate))).rejects.toThrow();
    } finally {
      spy.mockRestore();
      for (const reader of readers) {
        if (reader.pid !== undefined && reader.exitCode === null && reader.signalCode === null) {
          const closed = once(reader, "close");
          process.kill(-reader.pid, "SIGKILL");
          await closed;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
