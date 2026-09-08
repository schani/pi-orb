import type { ChildProcess, ExecFileException } from "node:child_process";
import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it, vi } from "vitest";

const execControls = vi.hoisted(() => ({
  calls: [] as Array<{
    file: string;
    args: readonly string[];
    options: { timeout?: number; killSignal?: NodeJS.Signals | number };
  }>,
  error: null as ExecFileException | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      file: string,
      args: readonly string[],
      options: { timeout?: number; killSignal?: NodeJS.Signals | number },
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      execControls.calls.push({ file, args, options });
      queueMicrotask(() => callback(execControls.error, "", ""));
      return {} as ChildProcess;
    },
  };
});

import { NodeSupervisorPorts, parseHealth } from "./adapters.ts";

const children: Array<ReturnType<NodeSupervisorPorts["spawn"]>> = [];

afterEach(() => {
  execControls.calls.length = 0;
  execControls.error = null;
  for (const result of children) {
    if (result.isOk() && result.value.process.pid !== undefined) {
      try {
        process.kill(-result.value.process.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    }
  }
  children.length = 0;
});

describe("runtime supervisor adapters", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", "ready"],
    ["an object without status", {}],
    ["an unknown status", { status: "what" }],
  ])("rejects health represented by %s", (_name, value) => {
    expect(parseHealth(value).isErr()).toBe(true);
  });

  it.each([
    ["missing error", { status: "failed" }],
    ["non-object error", { status: "failed", error: "broken" }],
    ["missing code", { status: "failed", error: {} }],
    ["non-string code", { status: "failed", error: { code: 23 } }],
    ["unsafe code", { status: "failed", error: { code: "../bad" } }],
    ["overlong code", { status: "failed", error: { code: "a".repeat(81) } }],
  ])("bounds a failed health response with %s", (_name, value) => {
    expect(parseHealth(value)._unsafeUnwrap()).toEqual({
      status: "failed",
      code: "runtime_failed",
    });
  });

  it.each(["runtime_failed", "a".repeat(80)])("preserves valid failure code %s", (code) => {
    expect(parseHealth({ status: "failed", error: { code } })._unsafeUnwrap()).toEqual({
      status: "failed",
      code,
    });
  });

  it("rejects a non-2xx health response even when its body says ready", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"status":"ready"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing test server address");
    try {
      const result = await new NodeSupervisorPorts({
        healthUrl: `http://127.0.0.1:${address.port}/v1/health`,
      }).health(new NoSimulationTask("supervisor adapter test", false));
      expect(result.isErr()).toBe(true);
    } finally {
      server.close();
    }
  });

  it("rejects malformed JSON from a successful health response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing test server address");
    try {
      const result = await new NodeSupervisorPorts({
        healthUrl: `http://127.0.0.1:${address.port}/v1/health`,
      }).health(new NoSimulationTask("supervisor adapter test", false));
      expect(result.isErr()).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns an asynchronous launch failure instead of polling forever", async () => {
    const ports = new NodeSupervisorPorts({ command: ["/definitely/missing/pi-orb-node"] });
    const spawned = ports.spawn();
    children.push(spawned);
    if (spawned.isErr()) {
      expect(spawned.error.type).toBe("spawn_failed");
      return;
    }
    const terminal = await ports.wait(spawned.value);
    expect(terminal.isErr()).toBe(true);
  });

  it("treats forwarding to an already reaped process group as complete", async () => {
    const ports = new NodeSupervisorPorts({ command: ["/bin/sh", "-c", "exit 0"] });
    const spawned = ports.spawn();
    children.push(spawned);
    const child = spawned._unsafeUnwrap();
    await ports.wait(child);
    expect(ports.forward(child, "SIGTERM").isOk()).toBe(true);
  });

  it("passes bounded diagnostic arguments", async () => {
    const result = await new NodeSupervisorPorts({ diagnostic: "/test/diagnostic" }).report(
      "failed",
      "runtime_failed",
      { exitCode: 23 },
    );
    expect(result.isOk()).toBe(true);
    expect(execControls.calls).toEqual([
      {
        file: "/test/diagnostic",
        args: ["runtime", "failed", "runtime_failed", "", '{"exitCode":23}'],
        options: { timeout: 30_000, killSignal: "SIGKILL" },
      },
    ]);
  });

  it.each([
    ["missing executable", Object.assign(new Error("missing"), { code: "ENOENT", cmd: "/test" })],
    ["bounded timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT", cmd: "/test" })],
  ])("returns diagnostic failure for %s", async (_name, cause) => {
    execControls.error = cause;
    const result = await new NodeSupervisorPorts({ diagnostic: "/test/diagnostic" }).report(
      "ready",
    );
    expect(result.isErr() && result.error.type).toBe("diagnostic_failed");
  });
});
