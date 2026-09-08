import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./.test/process-fixture.ts", import.meta.url));
type OwnedProcess = {
  child: ReturnType<typeof spawn>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  runtimePid: Promise<number>;
};
const processes: OwnedProcess[] = [];
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const owned of processes) {
    const runtimePid = await Promise.race([owned.runtimePid, owned.exit.then(() => undefined)]);
    if (runtimePid !== undefined) {
      try {
        process.kill(-runtimePid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    }
    if (owned.child.exitCode === null && owned.child.signalCode === null) {
      owned.child.kill("SIGKILL");
      await owned.exit;
    }
  }
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  processes.length = 0;
  servers.length = 0;
});

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

function launch(command: string[], healthUrl: string, diagnostic = "/usr/bin/true"): OwnedProcess {
  const child = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      SUPERVISOR_TEST_COMMAND: JSON.stringify(command),
      SUPERVISOR_TEST_HEALTH_URL: healthUrl,
      SUPERVISOR_TEST_DIAGNOSTIC: diagnostic,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
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
      resolve(message.runtimePid);
    });
    child.once("exit", () => reject(new Error("fixture exited before reporting runtime PID")));
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const owned = { child, exit, runtimePid };
  processes.push(owned);
  return owned;
}

async function handshake(): Promise<{ port: number; accepted: Promise<void> }> {
  const server = createServer();
  servers.push(server);
  const accepted = new Promise<void>((resolve) =>
    server.once("connection", (socket) => {
      socket.destroy();
      resolve();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing handshake address");
  return { port: address.port, accepted };
}

describe("runtime supervisor real processes", () => {
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
      const ready = await handshake();
      const cleaned = await handshake();
      const script = `
        const { spawn } = require("node:child_process");
        const { renameSync, writeFileSync } = require("node:fs");
        const { connect } = require("node:net");
        const [pidsPath, readyPort, cleanedPort] = process.argv.slice(1);
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const descendantExit = new Promise((resolve) => descendant.once("exit", resolve));
        writeFileSync(pidsPath + ".tmp", process.pid + " " + descendant.pid);
        renameSync(pidsPath + ".tmp", pidsPath);
        connect(Number(readyPort), "127.0.0.1", function () { this.end(); });
        for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => {
          await descendantExit;
          connect(Number(cleanedPort), "127.0.0.1", function () {
            this.end();
            process.removeAllListeners(signal);
            process.kill(process.pid, signal);
          });
        });
      `;
      const owned = launch(
        [process.execPath, "-e", script, pidsPath, String(ready.port), String(cleaned.port)],
        await healthServer(),
      );
      const runtimePid = await owned.runtimePid;
      await ready.accepted;
      const pids = (await readFile(pidsPath, "utf8")).split(" ");
      expect(pids).toHaveLength(2);
      expect(Number(pids[0])).toBe(runtimePid);
      owned.child.kill(signal);
      await cleaned.accepted;
      expect(await owned.exit).toEqual({ code: null, signal });
      for (const pid of pids) {
        expect(() => process.kill(Number(pid), 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }
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
