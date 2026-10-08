import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeEvidenceCapture, safeQualificationEvidence } from "./claude-receipt-edge.mjs";

const [root, workDir, brokerUrl, modelUrl, incarnation] = process.argv.slice(2);
const require = createRequire(`${root}/package.json`);
const { query } = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")));
const { ok, err, Result, ResultAsync } = require("neverthrow");
const { ClaudeOrbAgent } = await import(
  pathToFileURL(`${root}/apps/orb-runtime/src/claude/agent.ts`)
);
const processes = new Set();
let started = 0;
let exited = 0;
let accountChecked = false;
const streamRows = [];
const pendingBlocks = new Map();
let operationFailure = false;
let traceQueue = Promise.resolve();
const edgeCounts = new Map();
function sendSafe(message) {
  return Result.fromThrowable(
    () => process.send(message),
    () => ({ code: "qualification_ipc_unavailable" }),
  )();
}
function captureEvidence() {
  traceQueue = traceQueue.then(async () => {
    const captured = await captureNative();
    sendSafe({
      qualificationEvidence: {
        incarnation,
        ...safeQualificationEvidence({
          health: agent.getHealth(),
          ...captured,
          streamRows,
          pendingBlocks: [...pendingBlocks.values()],
          operationFailure,
          nativeSupervision: {
            spawned: started,
            closed: exited,
            active: processes.size,
            exitEdges: edgeCounts.get("native-exit") ?? 0,
            stdoutEOF: edgeCounts.get("native-stdout-eof") ?? 0,
            publicStreamEOF: edgeCounts.get("sdk-iterator-eof") ?? 0,
            hooksStarted: edgeCounts.get("hook-start") ?? 0,
            hooksEnded: edgeCounts.get("hook-end") ?? 0,
            hooksFailed: edgeCounts.get("hook-failed") ?? 0,
          },
        }),
        nativeCapture: captured.nativeCapture,
        nativeTraceUnavailable: captured.nativeCapture.status !== "captured",
      },
    });
  });
}
function observe(event) {
  edgeCounts.set(event, (edgeCounts.get(event) ?? 0) + 1);
  sendSafe({ nativeEdge: { incarnation, event } });
  captureEvidence();
}
const agent = new ClaudeOrbAgent({
  orbId: "00000000-0000-4000-8000-000000000029",
  repositoryUrl: "https://github.com/qualification/fixture",
  workDir,
  skillsDir: null,
  broker: { controlPlaneUrl: brokerUrl, runtimeToken: "synthetic-runtime-authority" },
  incarnation,
  sdkFactory(input, options) {
    try {
      // Assert production billing-source selection before replacing only the
      // destination/traffic flags for the isolated fake Messages backend.
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, "synthetic-subscription-not-a-credential");
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.settings.env.ANTHROPIC_API_KEY, "");
      let exit;
      const drained = new Promise((resolve) => {
        exit = resolve;
      });
      let stdout;
      const stdoutEnded = new Promise((resolve) => {
        stdout = resolve;
      });
      const sdk = query({
        prompt: input,
        options: {
          ...options,
          env: {
            ...options.env,
            ANTHROPIC_BASE_URL: modelUrl,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
          settings: {
            ...options.settings,
            env: { ...options.settings.env, ANTHROPIC_BASE_URL: modelUrl },
          },
          hooks: Object.fromEntries(
            Object.entries(options.hooks ?? {}).map(([name, matchers]) => [
              name,
              matchers.map((matcher) => ({
                ...matcher,
                hooks: matcher.hooks.map((hook) => async (...args) => {
                  observe("hook-start");
                  const result = await ResultAsync.fromThrowable(
                    () => hook(...args),
                    () => ({ code: "qualification_hook_failed" }),
                  )();
                  observe(result.isOk() ? "hook-end" : "hook-failed");
                  return result.isOk()
                    ? result.value
                    : { continue: false, stopReason: "qualification_hook_failed" };
                }),
              })),
            ]),
          ),
          spawnClaudeCodeProcess(spawnOptions) {
            const child = spawn(spawnOptions.command, spawnOptions.args, {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              stdio: ["pipe", "pipe", "pipe"],
            });
            started++;
            observe("native-spawn");
            processes.add(child);
            child.stdin.once("finish", () => observe("native-stdin-finish"));
            child.once("exit", () => observe("native-exit"));
            child.stderr.resume();
            child.once("close", () => {
              observe("native-close");
              exited++;
              processes.delete(child);
              exit();
            });
            child.once("error", () => {
              exit();
              stdout(err({ message: "Synthetic native process could not start." }));
            });
            child.stdout.once("end", () => {
              observe("native-stdout-eof");
              stdout(ok(undefined));
            });
            child.stdout.once("error", () =>
              stdout(err({ message: "Synthetic native stdout drain failed." })),
            );
            child.stdout.once("close", () => {
              if (!child.stdout.readableEnded)
                stdout(err({ message: "Synthetic native stdout closed without EOF." }));
            });
            return child;
          },
        },
      });
      // No accountInfo shim: the adapter verifies the genuine native account.
      const observed = new Proxy(sdk, {
        get(target, property) {
          if (property === Symbol.asyncIterator)
            return async function* () {
              for await (const message of target) {
                streamRows.push(...safeQualificationEvidence({ streamRows: [message] }).streamRows);
                if (streamRows.length > 128) streamRows.shift();
                const event = message.type === "stream_event" ? message.event : null;
                if (
                  event?.type === "content_block_start" &&
                  Number.isSafeInteger(event.index) &&
                  event.index >= 0 &&
                  event.index < 64
                )
                  pendingBlocks.set(event.index, {
                    index: event.index,
                    type: event.content_block.type,
                  });
                if (event?.type === "content_block_stop") pendingBlocks.delete(event.index);
                if (
                  ["content_block_start", "content_block_stop"].includes(event?.type) ||
                  ["assistant", "user", "system"].includes(message.type)
                )
                  captureEvidence();
                if (message.type === "result") {
                  operationFailure ||= message.is_error === true;
                  observe("sdk-result");
                }
                yield message;
              }
              observe("sdk-iterator-eof");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return ok({
        query: observed,
        exited: drained,
        stdoutEnded,
        requestShutdown: () =>
          Result.fromThrowable(
            () => {
              observe("native-shutdown-request");
              input.close();
            },
            () => ({ message: "Synthetic native input queue could not close." }),
          )(),
      });
    } catch {
      return err({ message: "Synthetic SDK composition failed." });
    }
  },
});

const captureNative = createNativeEvidenceCapture(agent, join(workDir, "claude", "config"));

function unwrap(result) {
  assert.equal(result.isOk(), true, "runtime API rejected synthetic qualification");
  return result.value;
}
function evidence() {
  return {
    snapshot: unwrap(agent.replicationSnapshot()),
    health: agent.getHealth(),
    started,
    exited,
    nativeProcesses: processes.size,
    accountChecked,
  };
}
async function idle() {
  if (agent.gateView().activity === "idle") return;
  await new Promise((resolve) => {
    const unsubscribe = agent.subscribe((frame) => {
      if (
        frame.type !== "runtime.event" ||
        frame.event.type !== "status" ||
        frame.event.activity !== "idle"
      )
        return;
      unsubscribe();
      resolve();
    });
  });
}
process.on("message", async ({ id, method, messageId, content }) => {
  try {
    let result;
    if (method === "boot" || method === "boot-uncertain") {
      await agent.boot();
      if (method === "boot-uncertain") {
        const health = agent.getHealth();
        assert.equal(health.status, "failed");
        assert.equal(health.error.code, "claude_delivery_uncertain");
        assert.equal(started, 0, "uncertain human delivery launched native inference");
        captureEvidence();
        await traceQueue;
        result = { health, started, exited, nativeProcesses: processes.size };
      } else {
        assert.equal(agent.getHealth().status, "ready", "real Claude boot did not reach ready");
        accountChecked = true;
        result = evidence();
      }
    } else if (method === "deliver") {
      result = unwrap(
        await agent.deliverInboxMessage(messageId, [messageId], [{ type: "text", text: content }]),
      );
    } else if (method === "idle" || method === "drained") {
      await agent.waitForStream();
      await agent.closeExtensions();
      assert.equal(agent.getHealth().status, "ready", "native drain failed before idle");
      await idle();
      captureEvidence();
      await traceQueue;
      result = evidence();
      assert.equal(result.nativeProcesses, 0, "idle preceded native process close");
      assert.equal(result.started, result.exited, "idle preceded supervised drain");
      if (method === "idle") assert.equal(unwrap(agent.prepareIdleStop()), true);
    } else if (method === "snapshot") {
      captureEvidence();
      await traceQueue;
      result = evidence();
    } else if (method === "close") {
      await agent.closeExtensions();
      agent.shutdownHooks();
      captureEvidence();
      await traceQueue;
      process.send({ id, result: true }, () => process.exit(0));
      return;
    } else {
      assert.fail("unknown fixture command");
    }
    process.send({ id, result });
  } catch {
    captureEvidence();
    await traceQueue;
    const health = agent.getHealth();
    process.send({
      id,
      error: `synthetic_runtime_${method}_${health.status === "failed" ? health.error.code : "assertion"}`,
    });
  }
});
process.send({ ready: true });
