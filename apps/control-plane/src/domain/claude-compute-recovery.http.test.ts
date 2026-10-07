import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  MCP_RUNTIME_PATH,
  ORB_BOOT_CONTEXT_PATH,
  PERSONAL_INSTRUCTIONS_RUNTIME_PATH,
  PROJECT_INSTRUCTIONS_RUNTIME_PATH,
  PROJECT_SECRETS_RUNTIME_PATH,
  runtimeClaudeSubscriptionPath,
  type ServerFrame,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { ok, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { ClaudeOrbAgent } from "../../../orb-runtime/src/claude/agent.ts";
import { readClaudeRecoveryProof } from "../../../orb-runtime/src/claude/recovery-proof.ts";
import { buildRuntimeServer } from "../../../orb-runtime/src/http/server.ts";
import type { TerminalManager } from "../../../orb-runtime/src/terminal/manager.ts";
import {
  ComposedClaudeFixture,
  childHook,
  rootResult,
  ScheduledClaudeQuery,
} from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { FetchRuntimeClient } from "../adapters/runtime-client/fetch-client.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

it.each(["ready", "missing-lifetime", "repeated-guard", "stop"] as const)(
  "failed guard HTTP/complete boot/WS recovery: %s",
  async (scenario) => {
    const task = new NoSimulationTask("claude-compute-recovery-http", false);
    const f = new ComposedClaudeFixture();
    const h = makeHarness();
    const environment = { ...process.env };
    const brokerRequests: string[] = [];
    const brokerBodies: Record<string, unknown> = {
      [PROJECT_SECRETS_RUNTIME_PATH]: { revision: 0, values: {} },
      [MCP_RUNTIME_PATH]: { revision: 0, servers: [] },
      [PERSONAL_INSTRUCTIONS_RUNTIME_PATH]: { revision: 0, content: "" },
      [PROJECT_INSTRUCTIONS_RUNTIME_PATH]: { revision: 0, content: "" },
      [ORB_BOOT_CONTEXT_PATH]: { v: 1, context: null, userTimeZone: null },
      [runtimeClaudeSubscriptionPath]: { token: "synthetic-no-inference", generation: 1 },
    };
    const broker = createServer((request, response) => {
      const path = request.url ?? "";
      brokerRequests.push(path);
      response.setHeader("content-type", "application/json");
      response.statusCode =
        request.headers.authorization === "Bearer synthetic-runtime" &&
        Object.hasOwn(brokerBodies, path)
          ? 200
          : 403;
      response.end(JSON.stringify(brokerBodies[path] ?? {}));
    });
    const apps: ReturnType<typeof buildRuntimeServer>[] = [];
    let socket: WebSocket | undefined;
    let replacement: ClaudeOrbAgent | undefined;
    let replacementQuery: ScheduledClaudeQuery | undefined;
    const serve = async (agent: ClaudeOrbAgent) => {
      const app = buildRuntimeServer(agent, {
        closeAll: () => undefined,
      } as unknown as TerminalManager);
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: 0 });
      return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    };
    try {
      broker.listen(0, "127.0.0.1");
      await once(broker, "listening");
      const brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
      f.state.cwd = join(f.dir, "repo");
      mkdirSync(join(f.state.cwd, ".agents"), { recursive: true });
      execFileSync("git", ["init", "--quiet", f.state.cwd]);
      execFileSync("git", [
        "-C",
        f.state.cwd,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      for (const hook of ["setup", "resume"])
        writeFileSync(
          join(f.state.cwd, ".agents", hook),
          `#!/bin/sh\nprintf ${hook} > .${hook}-ran\n`,
          { mode: 0o700 },
        );
      symlinkSync(f.configDir, join(f.dir, "claude", "config"), "dir");
      process.env.PI_ORB_CONTAINER = "0";
      expect((await f.attach()).isOk()).toBe(true);
      const oldUrl = await serve(f.agent);
      seedRunningOrb(task, h, "orb-a");
      h.store.seedOrb({ ...h.store.orbSnapshot("orb-a")!, harness: "claude" });
      const queued = await h.store.enqueueOrbMessage(task, {
        orbId: "orb-a",
        messageId: "inbox",
        content: [{ type: "text", text: "hello" }],
        wake: true,
        now: task.wallNow(),
      });
      expect(queued.isOk()).toBe(true);
      const runtimeClient = new FetchRuntimeClient();
      const context = { signal: new AbortController().signal };
      expect(
        (
          await runtimeClient.deliverMessage(
            task,
            {
              baseUrl: oldUrl,
              messageId: "inbox",
              messageIds: ["inbox"],
              content: [{ type: "text", text: "hello" }],
            },
            context,
          )
        ).isOk(),
      ).toBe(true);
      const input = await f.query.input.next();
      expect(input.done).not.toBe(true);
      f.receipt(input.value!);
      await f.query.emit(task, rootResult);
      await childHook(task, f);
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code: "claude_child_recovery_required" },
        recovery: { episode: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      if (scenario === "missing-lifetime") {
        const retained = f.journal();
        delete retained.guardLifetime;
        writeFileSync(join(f.dir, "claude", "session.json"), JSON.stringify(retained));
      }
      let currentUrl = oldUrl;
      let replacements = 0;
      const provider = h.deps.hostProvider;
      const deps = {
        ...h.deps,
        runtimeClient,
        hostProvider: new Proxy(provider, {
          get(target, key) {
            if (key === "observe")
              return (...args: Parameters<typeof provider.observe>) =>
                provider
                  .observe(...args)
                  .map((observation) =>
                    observation === null
                      ? null
                      : { ...observation, runtimeAddress: { baseUrl: currentUrl } },
                  );
            if (key === "provision")
              return (...args: Parameters<typeof provider.provision>) =>
                provider.provision(...args).andThen((value) =>
                  ResultAsync.fromSafePromise(
                    (async () => {
                      replacements++;
                      const proof = args[1].claudeRecoveryProof!;
                      expect(proof).toBeDefined();
                      expect(h.store.orbSnapshot("orb-a")?.claudeRecovery?.verified).toBe(true);
                      let queries = 0;
                      replacement = new ClaudeOrbAgent({
                        orbId: "orb-a",
                        workDir: f.dir,
                        repositoryUrl: "https://example.com/repo",
                        skillsDir: null,
                        broker: { controlPlaneUrl: brokerUrl, runtimeToken: "synthetic-runtime" },
                        incarnation: "1",
                        claudeRecoveryProof:
                          scenario === "repeated-guard"
                            ? undefined
                            : readClaudeRecoveryProof(JSON.stringify(proof)),
                        sdkFactory: (input, options) => {
                          replacementQuery = new ScheduledClaudeQuery(
                            input,
                            options,
                            queries++ === 0,
                          );
                          return ok({
                            query: replacementQuery,
                            exited: replacementQuery.processExit.promise,
                            stdoutEnded: replacementQuery.stdoutEnded,
                            requestShutdown: () => replacementQuery!.requestShutdown(),
                          });
                        },
                      });
                      await replacement.boot();
                      expect(existsSync(join(f.state.cwd, ".setup-ran"))).toBe(true);
                      expect(existsSync(join(f.state.cwd, ".resume-ran"))).toBe(true);
                      for (const path of Object.keys(brokerBodies))
                        expect(brokerRequests).toContain(path);
                      currentUrl = await serve(replacement);
                      return value;
                    })(),
                  ),
                );
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      await pollOrbUntilCaughtUp(task, deps, "orb-a", 1);
      expect(h.store.orbSnapshot("orb-a")?.state).toBe("starting");
      if (scenario === "stop") {
        expect((await requestOrbStop(task, deps, "orb-a")).isOk()).toBe(true);
        for (let i = 0; i < 20 && h.store.orbSnapshot("orb-a")?.state !== "stopped"; i++)
          await reconcileOrbOnce(task, deps, "orb-a");
        expect(h.store.orbSnapshot("orb-a")?.state).toBe("stopped");
        expect(replacements).toBe(0);
        expect(h.store.messageSnapshots("orb-a")[0]?.status).toBe("queued");
        return;
      }
      for (
        let i = 0;
        i < 20 && !["running", "failed"].includes(h.store.orbSnapshot("orb-a")?.state ?? "");
        i++
      )
        await reconcileOrbOnce(task, deps, "orb-a");
      if (scenario === "repeated-guard") {
        expect(h.store.orbSnapshot("orb-a")?.state).toBe("failed");
        expect(h.store.orbSnapshot("orb-a")?.lastError).toContain("exhausted");
        expect(f.journal().ownedChildren).toEqual({ child: "Native Claude agent" });
        expect(h.store.messageSnapshots("orb-a")[0]?.status).toBe("queued");
        for (let i = 0; i < 5; i++) await reconcileOrbOnce(task, deps, "orb-a");
        expect(replacements).toBe(1);
        return;
      }
      expect(h.store.orbSnapshot("orb-a")?.state).toBe("running");
      expect(f.journal().ownedChildren).toEqual({});
      expect(replacements).toBe(1);
      await pollOrbUntilCaughtUp(task, deps, "orb-a", 10);
      expect(h.store.messageSnapshots("orb-a")[0]?.status).toBe("delivered");
      expect(
        h.store
          .replicaRecords("orb-a")
          .filter(
            (record) =>
              (record.type === "message" || record.type === "event") &&
              record.inboxMessageIds?.includes("inbox"),
          ),
      ).toHaveLength(1);
      socket = new WebSocket(currentUrl.replace("http:", "ws:") + "/v1/live");
      const frames: ServerFrame[] = [];
      let synced!: () => void;
      const sync = new Promise<void>((resolve) => {
        synced = resolve;
      });
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        frames.push(frame);
        if (frame.type === "sync.completed") synced();
      });
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "recovery",
          afterRecordId: null,
        }),
      );
      await sync;
      expect(frames.some((frame) => frame.type === "sync.completed")).toBe(true);
      expect(
        (
          await runtimeClient.deliverMessage(
            task,
            {
              baseUrl: currentUrl,
              messageId: "inbox",
              messageIds: ["inbox"],
              content: [{ type: "text", text: "hello" }],
            },
            context,
          )
        )._unsafeUnwrap().duplicate,
      ).toBe(true);
      expect(
        (
          await runtimeClient.deliverMessage(
            task,
            {
              baseUrl: currentUrl,
              messageId: "next",
              messageIds: ["next"],
              content: [{ type: "text", text: "next" }],
            },
            context,
          )
        ).isOk(),
      ).toBe(true);
      const next = await replacementQuery!.input.next();
      expect(next.value?.message.content).toEqual([{ type: "text", text: "next" }]);
      expect(replacements).toBe(1);
    } finally {
      socket?.terminate();
      replacementQuery?.exit();
      replacementQuery?.endOutput();
      await replacement?.closeExtensions();
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      for (const app of apps.reverse()) await app.close();
      if (broker.listening)
        await new Promise<void>((resolve, reject) =>
          broker.close((error) => (error ? reject(error) : resolve())),
        );
      for (const name of Object.keys(process.env))
        if (!(name in environment)) delete process.env[name];
      Object.assign(process.env, environment);
      f.dispose();
    }
  },
);
