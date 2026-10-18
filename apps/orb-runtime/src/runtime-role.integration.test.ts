import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("real process runtime role", () => {
  it.each(["claude", "execution"] as const)(
    "starts authenticated %s runtime health before failed repository boot",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "runtime-role-"));
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test port unavailable");
      const port = address.port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const listenProbe = `import { Server } from "node:net";
        const emit = Server.prototype.emit;
        Server.prototype.emit = function(event, ...args) {
          const emitted = emit.call(this, event, ...args);
          if (event === "listening" && this.address()?.port === Number(process.env.PI_ORB_RUNTIME_PORT))
            process.send?.("runtime-listening");
          return emitted;
        };`;
      const child = spawn(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(listenProbe)}`,
          "apps/orb-runtime/src/runtime-entry.ts",
        ],
        {
          env: {
            ...process.env,
            PI_ORB_RUNTIME_MODE: mode,
            PI_ORB_WORK_DIR: directory,
            PI_ORB_RUNTIME_PORT: String(port),
            PI_ORB_ID: "test-role",
            PI_ORB_HOST_INCARNATION: "2",
            PI_ORB_REPOSITORY_URL: "invalid-repository",
            PI_ORB_SKILLS_DIR: join(directory, "skills"),
            PI_ORB_CONTROL_PLANE_URL: "http://127.0.0.1:1",
            PI_ORB_RUNTIME_TOKEN: "test-secret",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let logs = "";
      child.stdout?.on("data", (chunk) => {
        logs += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        logs += String(chunk);
      });
      try {
        const ready = once(child, "message");
        const failed = once(child, "exit").then(() => {
          throw new Error(`runtime exited before listening: ${logs}`);
        });
        expect(await Promise.race([ready, failed])).toEqual(["runtime-listening", undefined]);
        const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
        expect(response.status, logs).toBe(200);
        expect(await response.json()).toMatchObject({ v: 1, orbId: "test-role" });
        const unauthorized = await fetch(
          `http://127.0.0.1:${port}/${mode === "execution" ? "execution/ready" : "v1/history"}`,
        );
        expect(unauthorized.status).toBe(mode === "execution" ? 401 : 503);
      } finally {
        const exited = child.exitCode !== null ? Promise.resolve() : once(child, "exit");
        child.kill("SIGTERM");
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});
