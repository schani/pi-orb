import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { err, ok, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { withOrphanMonitor } from "../../../../scripts/claude-sdk-contract/orphan-monitor.mjs";
import { memoryHistoryFiles, ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
import { ClaudeOrbAgent, type NativeState } from "./agent.ts";
import { ClaudeHistory } from "./history.ts";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each(["stdin-race", "pre-human-failure"] as const)(
  "native Monitor recovery: %s",
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "claude-orphan-monitor-"));
    const configDir = join(dir, "config");
    mkdirSync(join(dir, "claude"));
    mkdirSync(configDir);
    const state: NativeState = {
      id: "a994788d-2476-42d4-950c-ccbf33050cdd",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: dir,
      deliveries: {},
      model: "claude-sonnet-5-5",
      effort: "high",
    };
    const files = memoryHistoryFiles();
    const history = new ClaudeHistory(join(dir, "claude"), state.id, state.timestamp, files);
    const events: Record<string, unknown>[] = [];
    let nativeFactory: ConstructorParameters<typeof ClaudeOrbAgent>[0]["sdkFactory"];
    const agent = new ClaudeOrbAgent({
      orbId: "orphan-monitor",
      repositoryUrl: null,
      workDir: dir,
      skillsDir: null,
      broker: null,
      files,
      yieldMessage: async () => undefined,
      sdkFactory: (input, options) => {
        if (nativeFactory !== undefined) return nativeFactory(input, options);
        const metadata = new ScheduledClaudeQuery(input, options, true);
        metadata.supportedModels = async () => [
          {
            value: "claude-sonnet-5-5",
            displayName: "fixture",
            description: "",
            supportedEffortLevels: ["high"],
          },
        ];
        return ok({
          query: metadata,
          exited: metadata.processExit.promise,
          stdoutEnded: metadata.stdoutEnded,
          requestShutdown: () => metadata.requestShutdown(),
        });
      },
    });
    let evidence: Awaited<ReturnType<typeof withOrphanMonitor>> | undefined;
    let unblockNative = () => {};
    try {
      expect((await agent.attachSession(state, history, configDir, null)).isOk()).toBe(true);
      evidence = await withOrphanMonitor({
        cwd: dir,
        configDir,
        sessionId: state.id,
        artifactName: scenario,
        run: async ({ env, wrapSpawn, events: nativeEvents, trackQuery, cancel }) => {
          const humanHeld = gate();
          const acknowledgmentWaiting = gate();
          let releaseWrite = () => {};
          unblockNative = () => {
            acknowledgmentWaiting.resolve();
            humanHeld.resolve();
            releaseWrite();
          };
          let initialHumanUuid: string | undefined;
          nativeFactory = (input, options) => {
            const exited = gate();
            let stdoutDone: (result: Result<void, { message: string }>) => void = () => {};
            const stdoutEnded = new Promise<Result<void, { message: string }>>((resolve) => {
              stdoutDone = resolve;
            });
            const originalSpawn = options.spawnClaudeCodeProcess;
            if (originalSpawn === undefined) throw new Error("Production spawner missing.");
            const native = query({
              prompt: {
                async *[Symbol.asyncIterator]() {
                  for await (const message of input) {
                    events.push({ type: "production-input", message });
                    yield message;
                  }
                  events.push({ type: "production-input-eof" });
                },
              },
              options: {
                ...options,
                env,
                settings: {},
                settingSources: [],
                tools: ["Monitor"],
                spawnClaudeCodeProcess: (spawnOptions) => {
                  const child = wrapSpawn(originalSpawn)(spawnOptions);
                  const actualStdin = child.stdin;
                  // Real pipe backpressure: preserve FIFO and let InputQueue.close produce EOF.
                  const transport = new Transform({
                    transform(chunk, _encoding, callback) {
                      const message = JSON.parse(chunk.toString());
                      if (message.type === "user" && message.origin?.kind === "human") {
                        initialHumanUuid = message.uuid;
                        events.push({ type: "human-stdin-held", uuid: message.uuid });
                        releaseWrite = () => {
                          releaseWrite = () => {};
                          events.push({ type: "human-stdin-released", uuid: message.uuid });
                          callback(null, chunk);
                        };
                        humanHeld.resolve();
                      } else callback(null, chunk);
                    },
                  });
                  transport.on("error", () => unblockNative());
                  actualStdin.on("error", (error) => transport.destroy(error));
                  transport.pipe(actualStdin);
                  Object.defineProperty(child, "stdin", { value: transport });
                  child.on("exit", () => {
                    unblockNative();
                    exited.resolve();
                  });
                  child.on("error", () => {
                    unblockNative();
                    exited.resolve();
                    stdoutDone(err({ message: "Fixture subprocess failed." }));
                  });
                  child.stdout.on("end", () => stdoutDone(ok(undefined)));
                  child.stdout.on("error", () =>
                    stdoutDone(err({ message: "Fixture stdout failed." })),
                  );
                  child.stdout.on("close", () =>
                    stdoutDone(err({ message: "Fixture stdout closed without EOF." })),
                  );
                  return child;
                },
              },
            });
            trackQuery({
              close: () => {
                unblockNative();
                native.close();
              },
            });
            return ok({
              query: {
                close: () => {
                  unblockNative();
                  native.close();
                },
                accountInfo: async () => {
                  const account = await native.accountInfo();
                  if (scenario === "pre-human-failure") {
                    await acknowledgmentWaiting.promise;
                    cancel();
                    throw new Error("fixture pre-human initialization failure");
                  }
                  return account;
                },
                supportedModels: () => native.supportedModels(),
                setModel: (model) => native.setModel(model),
                applyFlagSettings: (settings) => native.applyFlagSettings(settings),
                interrupt: () => native.interrupt(),
                async *[Symbol.asyncIterator]() {
                  for await (const message of native) {
                    nativeEvents.push({ type: "sdk-output", phase: "resume", message });
                    if (message.type === "result" && message.num_turns === 0) {
                      // Buffer stdout until the initial human write is accepted, not yet delivered.
                      events.push({ type: "orphan-ack-buffered", message });
                      acknowledgmentWaiting.resolve();
                      await humanHeld.promise;
                      events.push({ type: "orphan-ack-delivered", message });
                    }
                    yield message;
                    if (message.type === "result" && message.num_turns === 0) releaseWrite();
                    events.push({
                      type: "adapter-consumed",
                      messageType: message.type,
                      health: agent.getHealth(),
                    });
                  }
                },
              },
              exited: exited.promise,
              stdoutEnded,
              requestShutdown: () => {
                events.push({ type: "production-shutdown-request", health: agent.getHealth() });
                unblockNative();
                return ok(undefined);
              },
            });
          };
          const admitted = await agent.deliverInboxMessage(
            "human",
            ["human"],
            [{ type: "text", text: "Return the fixed resumed answer." }],
          );
          events.push({ type: "human-admission-result", ok: admitted.isOk() });
          expect(admitted.isOk()).toBe(scenario === "stdin-race");
          await agent.waitForStream();
          await agent.closeExtensions();
          return { initialHumanUuid };
        },
      });
      const outputs = evidence.events
        .filter((event) => event.type === "sdk-output" && event.phase === "resume")
        .map((event) => event.message as SDKMessage);
      if (scenario === "pre-human-failure") {
        expect(events.some((event) => event.type === "orphan-ack-buffered")).toBe(true);
        expect(events.some((event) => event.type === "human-stdin-held")).toBe(false);
        expect(agent.getHealth()).toMatchObject({
          status: "failed",
          error: { code: "claude_initialization_failed" },
        });
        expect(
          evidence.events.filter((event) => event.type === "native-process-closed"),
        ).toHaveLength(2);
        return;
      }
      const acknowledgment = outputs.find(
        (message) => message.type === "result" && message.num_turns === 0,
      );
      expect(acknowledgment).toMatchObject({
        subtype: "success",
        is_error: false,
        queued_turn_count: 0,
        stop_reason: null,
        origin: { kind: "task-notification" },
      });
      expect(acknowledgment).not.toHaveProperty("user_message_uuid");
      expect(acknowledgment).not.toHaveProperty("user_message_uuids");
      expect(evidence.runResult.initialHumanUuid).toBeTypeOf("string");
      expect(acknowledgment?.uuid).not.toBe(evidence.runResult.initialHumanUuid);
      expect(state.deliveries["human"]?.uuid).toBe(evidence.runResult.initialHumanUuid);
      expect(events.find((event) => event.type === "production-input")).toMatchObject({
        message: { uuid: evidence.runResult.initialHumanUuid },
      });
      expect(
        history.view.some(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toBe(true);
      expect(
        outputs.find(
          (message) => message.type === "system" && message.subtype === "task_notification",
        ),
      ).toMatchObject({ status: "stopped", task_id: evidence.taskId });
      const failure = history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
      );
      expect(failure).toBeUndefined();
      const requesting = outputs.find(
        (message) =>
          message.type === "system" &&
          message.subtype === "status" &&
          message.status === "requesting",
      );
      expect(requesting).toMatchObject({
        user_message_uuids: [evidence.runResult.initialHumanUuid],
      });
      expect(outputs.indexOf(acknowledgment as SDKMessage)).toBeLessThan(
        outputs.indexOf(requesting as SDKMessage),
      );
      expect(
        outputs.find((message) => message.type === "result" && message.num_turns > 0),
      ).toMatchObject({
        user_message_uuids: [evidence.runResult.initialHumanUuid],
        stop_reason: "end_turn",
      });
      const held = events.findIndex((event) => event.type === "human-stdin-held");
      const ack = events.findIndex((event) => event.type === "orphan-ack-delivered");
      const released = events.findIndex((event) => event.type === "human-stdin-released");
      const close = events.findIndex((event) => event.type === "production-shutdown-request");
      const eof = events.findIndex((event) => event.type === "production-input-eof");
      for (const index of [held, ack, released, close, eof])
        expect(index).toBeGreaterThanOrEqual(0);
      expect(held).toBeLessThan(ack);
      expect(ack).toBeLessThan(released);
      expect(released).toBeLessThan(close);
      expect(close).toBeLessThan(eof);
      expect(agent.getHealth()).toMatchObject({
        status: "ready",
        activity: "idle",
      });
    } finally {
      unblockNative();
      await agent.closeExtensions();
      const artifactDir = process.env["CLAUDE_UNOWNED_ARTIFACT_DIR"];
      if (artifactDir !== undefined) {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          join(artifactDir, `orphan-monitor-${scenario}.json`),
          JSON.stringify(
            {
              evidence,
              events,
              health: agent.getHealth(),
              history: history.view,
            },
            null,
            2,
          ),
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
