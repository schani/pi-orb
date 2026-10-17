import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = fileURLToPath(new URL("./.test/process-fixture.ts", import.meta.url));
const runtimeTree = fileURLToPath(new URL("./.test/runtime-tree-fixture.ts", import.meta.url));
type OwnedProcess = {
  child: ReturnType<typeof spawn>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  runtimePid: Promise<number>;
  knownRuntimePid?: number;
  trace: string[];
  stderr: string;
};
const processes: OwnedProcess[] = [];
const servers: Server[] = [];
const directories: string[] = [];
const sockets: Socket[] = [];

afterEach(async ({ task }) => {
  if (task.result?.state === "fail")
    for (const owned of processes) console.error({ trace: owned.trace, stderr: owned.stderr });
  try {
    await cleanupProcesses(processes);
  } finally {
    processes.length = 0;
    try {
      for (const socket of sockets.splice(0)) socket.destroy();
    } finally {
      try {
        await Promise.all(
          servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
      } finally {
        await Promise.all(
          directories.splice(0).map((directory) => rm(directory, { recursive: true })),
        );
      }
    }
  }
});

async function cleanupProcesses(ownedProcesses: OwnedProcess[]): Promise<void> {
  const errors: unknown[] = [];
  for (const owned of ownedProcesses) {
    try {
      if (owned.knownRuntimePid !== undefined) process.kill(-owned.knownRuntimePid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
        errors.push(cause);
    } finally {
      try {
        if (owned.child.exitCode === null && owned.child.signalCode === null)
          owned.child.kill("SIGKILL");
        await owned.exit;
      } catch (cause) {
        errors.push(cause);
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "owned process cleanup failed");
}

async function healthServer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ready"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing health address");
  return `http://127.0.0.1:${address.port}/v1/health`;
}

function launch(
  command: string[],
  healthUrl: string,
  diagnostic = "/usr/bin/true",
  fixturePath = fixture,
): OwnedProcess {
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      SUPERVISOR_TEST_COMMAND: JSON.stringify(command),
      SUPERVISOR_TEST_HEALTH_URL: healthUrl,
      SUPERVISOR_TEST_DIAGNOSTIC: diagnostic,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const runtimePid = new Promise<number>((resolve, reject) => {
    child.once("message", (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("runtimePid" in message) ||
        typeof message.runtimePid !== "number"
      ) {
        reject(new Error("invalid runtime PID message"));
        return;
      }
      owned.knownRuntimePid = message.runtimePid;
      owned.trace.push(`runtime PID/group ${message.runtimePid}`);
      resolve(message.runtimePid);
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("fixture exited before reporting runtime PID")));
  });
  // Exit-only tests still observe early IPC rejection; awaiting runtimePid retains the error.
  void runtimePid.catch(() => {});
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        owned.trace.push(`supervisor exited code=${code} signal=${signal}`);
        resolve({ code, signal });
      });
    },
  );
  const owned: OwnedProcess = { child, exit, runtimePid, trace: ["launched"], stderr: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    owned.stderr = (owned.stderr + chunk.toString()).slice(-8_192);
  });
  processes.push(owned);
  return owned;
}

async function handshake(hold = false) {
  let connection: Socket | undefined;
  const server = createServer();
  servers.push(server);
  const accepted = new Promise<void>((resolve) =>
    server.once("connection", (socket) => {
      connection = socket;
      sockets.push(socket);
      if (!hold) socket.destroy();
      resolve();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing handshake address");
  return {
    port: address.port,
    accepted,
    connected: () => connection !== undefined,
    release: () => connection?.destroy(),
  };
}

async function phase(owned: OwnedProcess, name: string, barrier: Promise<void>): Promise<void> {
  owned.trace.push(`waiting: ${name}`);
  await Promise.race([
    barrier,
    owned.exit.then((exit) => {
      throw new Error(`exited before ${name}: ${JSON.stringify(exit)}; ${owned.trace.join("; ")}`);
    }),
  ]);
  owned.trace.push(`accepted: ${name}`);
}

describe("runtime supervisor real processes", () => {
  it("cleans up a fixture stalled before runtime spawn without awaiting its PID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-orb-supervisor-stall-"));
    directories.push(directory);
    const script = join(directory, "stalled.mjs");
    await writeFile(
      script,
      `import { connect } from "node:net";
const url = new URL(process.env.SUPERVISOR_TEST_HEALTH_URL);
connect(Number(url.port), url.hostname);
setInterval(() => {}, 1_000);
`,
    );
    const ready = await handshake(true);
    const owned = launch(["unused"], `http://127.0.0.1:${ready.port}`, undefined, script);
    // Observe any attempted PID wait causally; fixture rescue needs no deadline.
    await phase(owned, "fixture startup held before spawn", ready.accepted);
    let reportWait = () => {};
    const waited = new Promise<void>((resolve) => {
      reportWait = resolve;
    });
    const then = owned.runtimePid.then.bind(owned.runtimePid);
    const spy = vi.spyOn(owned.runtimePid, "then").mockImplementation((...args) => {
      reportWait();
      return then(...args);
    });
    const cleanup = cleanupProcesses([owned]).then(
      () => "cleaned",
      () => "failed",
    );
    try {
      expect(await Promise.race([cleanup, waited.then(() => "waited for unknown PID")])).toBe(
        "cleaned",
      );
      expect(await owned.exit).toEqual({ code: null, signal: "SIGKILL" });
      await expect(owned.runtimePid).rejects.toThrow("fixture exited before reporting runtime PID");
    } finally {
      spy.mockRestore();
      owned.child.kill("SIGKILL");
      await owned.exit;
      await cleanup;
    }
  });

  it("kills every owned fixture even when a runtime group kill fails", async () => {
    const owned = [
      launch([process.execPath, "-e", "setInterval(() => {}, 1000)"], await healthServer()),
      launch([process.execPath, "-e", "setInterval(() => {}, 1000)"], await healthServer()),
    ];
    const [firstPid] = await Promise.all(owned.map((process) => process.runtimePid));
    const failure = new Error("forced group kill failure");
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      // Kill the real group before injecting failure so this witness cannot orphan it.
      const killed = kill(pid, signal);
      if (pid === -Number(firstPid)) throw failure;
      return killed;
    });
    try {
      const result = await cleanupProcesses(owned).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      for (const fixture of owned) expect(fixture.child.signalCode).toBe("SIGKILL");
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([failure]);
    } finally {
      spy.mockRestore();
      await cleanupProcesses(owned);
    }
  });

  it("forwards the runtime exit code", async () => {
    const owned = launch(["/bin/sh", "-c", "exit 23"], await healthServer());
    expect(await owned.exit).toEqual({ code: 23, signal: null });
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to the runtime group and waits for descendant cleanup",
    async (signal) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-orb-supervisor-"));
      directories.push(directory);
      const pidsPath = join(directory, "pids");
      const ready = await handshake(true);
      const descendantReady = await handshake();
      const descendantSignalled = await handshake(true);
      const handling = await handshake();
      const cleaned = await handshake();
      const owned = launch(
        [
          process.execPath,
          runtimeTree,
          pidsPath,
          ...[ready, descendantReady, descendantSignalled, handling, cleaned].map(({ port }) =>
            String(port),
          ),
        ],
        await healthServer(),
      );
      const runtimePid = await owned.runtimePid;
      await phase(owned, "runtime readiness (execution held)", ready.accepted);
      await phase(owned, "descendant handlers ready", descendantReady.accepted);
      const pids = (await readFile(pidsPath, "utf8")).split(" ");
      expect(pids).toHaveLength(2);
      expect(Number(pids[0])).toBe(runtimePid);
      owned.trace.push(`sending ${signal} to supervisor ${owned.child.pid}`);
      expect(owned.child.kill(signal)).toBe(true);
      await phase(owned, "runtime signal handler", handling.accepted);
      await phase(owned, "descendant signal handler (exit held)", descendantSignalled.accepted);
      expect(cleaned.connected()).toBe(false);
      for (const pid of pids) expect(() => process.kill(Number(pid), 0)).not.toThrow();
      owned.trace.push("releasing descendant exit; runtime execution remains held");
      descendantSignalled.release();
      await phase(owned, "descendant cleanup", cleaned.accepted);
      expect(await owned.exit).toEqual({ code: null, signal });
      for (const pid of pids) {
        expect(() => process.kill(Number(pid), 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }
      console.info({ signal, trace: owned.trace, stderr: owned.stderr });
    },
  );

  it("forwards an early runtime signal", async () => {
    const owned = launch(["/bin/sh", "-c", "kill -INT $$"], await healthServer());
    expect(await owned.exit).toEqual({ code: null, signal: "SIGINT" });
  });

  it("keeps a diagnostic executable failure best-effort", async () => {
    const owned = launch(
      ["/bin/sh", "-c", "sleep 0.1; exit 19"],
      await healthServer(),
      "/definitely/missing/pi-orb-diagnostic",
    );
    expect(await owned.exit).toEqual({ code: 19, signal: null });
  });
});
