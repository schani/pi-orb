import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NoSimulationTask } from "determined";
import { expect, test } from "vitest";
import { ProcessOrbHostProvider } from "../process/provider.ts";
import { RemoteExecutionEnv } from "./env.ts";

test.skipIf(process.platform !== "linux").each(["guest", "supervisor"] as const)(
  "process disposal after %s SIGKILL reports actual shell ownership",
  async (killedOwner) => {
    const root = await mkdtemp(join(tmpdir(), "execution-crash-"));
    let ready!: () => void;
    const booted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = createServer((_request, response) => {
      response.end();
      ready();
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const fixture = join(root, "runtime.mjs");
    await writeFile(
      fixture,
      `
import { mkdir } from "node:fs/promises";
import { buildExecutionServer } from ${JSON.stringify(pathToFileURL(resolve("apps/orb-runtime/src/execution/server.ts")).href)};
const cwd = process.env.PI_ORB_WORK_DIR + "/repo";
await mkdir(cwd, { recursive: true });
const app = buildExecutionServer({ token: process.env.PI_ORB_RUNTIME_TOKEN, incarnation: process.env.PI_ORB_HOST_INCARNATION, cwd });
await app.listen({ port: Number(process.env.PI_ORB_RUNTIME_PORT), host: "127.0.0.1" });
await fetch(process.env.TEST_READY_URL);
process.on("SIGTERM", async () => { await app.close(); process.exit(0); });
`,
    );
    const provider = new ProcessOrbHostProvider({
      stateDirectory: join(root, "state"),
      runtimeEntryPoint: fixture,
      controlPlaneUrl: "http://unused",
      skillsDir: root,
      restartDelayMs: 60_000,
      extraEnv: { TEST_READY_URL: `http://127.0.0.1:${(gate.address() as AddressInfo).port}` },
    });
    const task = new NoSimulationTask("execution crash disposal", false);
    const operation = { signal: new AbortController().signal };
    let shellPid: number | undefined;
    try {
      const provisioned = await provider.provision(
        task,
        {
          orbId: "crash",
          incarnation: 1,
          bootstrap: { repositoryUrl: "https://github.com/test/test" },
        },
        operation,
      );
      expect(provisioned.isOk()).toBe(true);
      if (provisioned.isErr()) return;
      await booted;
      const binding = await provider.executionBinding(task, provisioned.value.ref, operation);
      expect(binding.isOk()).toBe(true);
      if (binding.isErr()) return;
      const env = new RemoteExecutionEnv(binding.value);
      const host = await env.ready(BACKGROUND_CONTEXT);
      expect(host.isOk()).toBe(true);
      if (host.isErr()) return;
      let admitted!: () => void;
      const started = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const command = env.exec(
        "mkfifo gate; echo $$ > shell-pid; echo admitted; read ignored < gate; echo bad > late-effect",
        {
          onOutput: () => admitted(),
        },
        BACKGROUND_CONTEXT,
      );
      expect(
        await Promise.race([started.then(() => "started"), command.then(() => "finished")]),
      ).toBe("started");
      const pid = await env.readTextFile("shell-pid", BACKGROUND_CONTEXT);
      expect(pid.ok).toBe(true);
      if (!pid.ok) return;
      shellPid = Number(pid.value.trim());
      const metadata = JSON.parse(
        readFileSync(join(root, "state", "crash", "host.json"), "utf8"),
      ) as { processGroupId: number };
      process.kill(killedOwner === "guest" ? host.value.pid : metadata.processGroupId, "SIGKILL");
      if (killedOwner === "supervisor") {
        process.kill(host.value.pid, "SIGKILL");
        await writeFile(
          join(root, "state", "crash", "drained.json"),
          JSON.stringify({ launch: "previous-launch" }),
        );
      }
      const outcome = await command;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe("unknown");
      const discarded = await provider.discardCompute(
        task,
        { orbId: "crash", throughIncarnation: 1 },
        operation,
      );
      expect(discarded.isOk()).toBe(killedOwner === "guest");
      if (discarded.isErr()) {
        expect(discarded.error.message).toContain("cleanup is unknown");
        const restarted = await provider.start(
          task,
          {
            ref: provisioned.value.ref,
            expectedIncarnation: provisioned.value.incarnation,
            expectedSpecFingerprint: provisioned.value.specFingerprint,
          },
          operation,
        );
        expect(restarted.isErr()).toBe(true);
        if (restarted.isErr()) expect(restarted.error.message).toContain("refusing relaunch");
      }
      let state: string | undefined;
      try {
        state = /^\d+ \(.*\) ([A-Z]) /.exec(readFileSync(`/proc/${shellPid}/stat`, "utf8"))?.[1];
      } catch {}
      expect(state === undefined || state === "Z").toBe(killedOwner === "guest");
    } finally {
      if (shellPid) {
        try {
          process.kill(-shellPid, "SIGKILL");
        } catch {}
      }
      await provider.close();
      gate.closeAllConnections();
      await new Promise<void>((resolve) => gate.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
