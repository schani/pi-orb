import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  query: vi.fn(),
  closed: false,
  earlyRemoval: false,
}));
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
