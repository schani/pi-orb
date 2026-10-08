import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

function reply(response, turn, withSubagent) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const emit = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", {
    message: {
      id: `msg_contract_${turn}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 16, output_tokens: 0 },
    },
  });
  if (withSubagent && turn === 1) {
    emit("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_contract_agent",
        name: "Agent",
        input: {},
      },
    });
    emit("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          subagent_type: "contract-child",
          prompt: "Run the fixed Bash contract marker, then finish.",
          description: "Native contract child",
        }),
      },
    });
  } else if (turn === (withSubagent ? 2 : 1)) {
    emit("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_contract_bash",
        name: "Bash",
        input: {},
      },
    });
    emit("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          command: "printf native-contract-fixed-output",
          description: "Print the contract marker",
        }),
      },
    });
  } else {
    emit("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    emit("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Contract complete." },
    });
  }
  emit("content_block_stop", { index: 0 });
  emit("message_delta", {
    delta: {
      stop_reason: turn === 1 || (withSubagent && turn === 2) ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 8 },
  });
  emit("message_stop", {});
  response.end();
}
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) =>
    error.code === "ENOENT" ? [] : Promise.reject(error),
  );
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      ),
    )
  ).flat();
}

/** Only dummy API credentials, isolated native configuration, and a loopback endpoint. */
export async function probeNativeSdk({
  withSubagent = false,
  withCompact = false,
  compactInstructions = "",
  cancelAt,
  withRestart,
  onRoot,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-native-contract-"));
  const cwd = join(home, "workspace");
  const config = join(home, "config");
  await mkdir(cwd);
  await mkdir(config);
  let requestCount = 0;
  let unexpectedRequest = null;
  const requestSettings = [];
  let compactAdmitted = false;
  let compactProviderRequests = 0;
  let customInstructionsReachedProvider = false;
  let interrupt;
  let interruptTask;
  let interruptError;
  const cancellation = {
    requested: false,
    accepted: false,
    drained: false,
    receipt: null,
  };
  let restarting = false;
  const restartRequests = [];
  const server = createServer((request, response) => {
    // Retain settings and synthetic restart context only; never headers or credentials.
    if (request.method === "POST" && request.url?.split("?")[0] === "/v1/messages") {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(text);
        text = "";
        requestSettings.push({
          model: body.model,
          effort: body.output_config?.effort ?? null,
        });
        if (restarting) restartRequests.push(body.messages);
        ++requestCount;
        if (compactAdmitted) {
          ++compactProviderRequests;
          customInstructionsReachedProvider ||= Boolean(
            compactInstructions && JSON.stringify(body).includes(compactInstructions),
          );
          if (cancelAt === "in-progress") {
            // The request is dispatched, but no response bytes exist until cancellation.
            interruptTask = interrupt().catch((error) => {
              interruptError = error;
            });
            return;
          }
        }
        reply(response, requestCount, withSubagent);
      });
    } else if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"input_tokens":16}');
    } else if (request.method === "HEAD" && request.url === "/api/hello") {
      response.writeHead(200);
      response.end();
    } else {
      unexpectedRequest = `${request.method} ${request.url?.split("?")[0]}`;
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: "dummy-native-contract-not-a-real-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ...(withSubagent ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
  };
  const sessionId = randomUUID();
  const submittedUuid = randomUUID();
  const compactUuid = randomUUID();
  let release;
  let beginCompact;
  let preCompactSource;
  let preCompactMessageCount = 0;
  let initialized;
  let cancelled = false;
  const initializationFence = new Promise((resolve) => {
    initialized = resolve;
  });
  let enterCompact;
  let queuedDelivered;
  let releaseQueuedHook;
  const queuedHookHold = new Promise((resolve) => {
    releaseQueuedHook = resolve;
  });
  const compactEntered = new Promise((resolve) => {
    enterCompact = resolve;
  });
  const queuedWritten = new Promise((resolve) => {
    queuedDelivered = resolve;
  });
  const input = {
    async *[Symbol.asyncIterator]() {
      if (cancelAt === "initialization") await initializationFence;
      if (cancelled) return;
      yield {
        type: "user",
        uuid: submittedUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: "Run the fixed Bash contract marker, then finish.",
        },
      };
      if (withCompact) {
        await new Promise((resolve) => {
          beginCompact = resolve;
        });
        if (cancelled) return;
        yield {
          type: "user",
          uuid: compactUuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: `/compact${compactInstructions ? ` ${compactInstructions}` : ""}`,
          },
        };
        if (cancelAt === "queued") {
          await compactEntered;
          cancellation.queuedUuid = randomUUID();
          yield {
            type: "user",
            uuid: cancellation.queuedUuid,
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { role: "user", content: "/compact" },
          };
          // SDK asks for the next item only after writing the previous item.
          queuedDelivered();
        }
      }
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  let child;
  let exited;
  let sdk;
  let timedOut = false;
  const messages = [];
  const killOwnedGroup = () => {
    if (!child) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    sdk?.close();
    killOwnedGroup();
  }, 20_000);
  try {
    const options = {
      cwd,
      env,
      sessionId,
      settingSources: [],
      tools: withSubagent ? ["Bash", "Agent"] : ["Bash"],
      plugins: [],
      ...(cancelAt === "before-dispatch" || cancelAt === "queued"
        ? {
            hooks: {
              PreCompact: [
                {
                  hooks: [
                    async () => {
                      if (cancelAt === "queued") {
                        if (cancellation.requested) await queuedHookHold;
                        enterCompact();
                        await queuedWritten;
                      }
                      await interrupt();
                      return {};
                    },
                  ],
                },
              ],
            },
          }
        : {}),
      ...(withSubagent
        ? {
            agents: {
              "contract-child": {
                description: "Native contract child",
                prompt: "Run the fixed Bash contract marker, then finish.",
                tools: ["Bash"],
                model: "inherit",
                background: false,
              },
            },
          }
        : {}),
      model: "claude-sonnet-5-5",
      effort: "low",
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      spawnClaudeCodeProcess: (options) => {
        child = spawn(
          "/usr/bin/python3",
          [
            fileURLToPath(new URL("./network-guard.py", import.meta.url)),
            options.command,
            ...options.args,
          ],
          {
            cwd: options.cwd,
            env: { ...options.env, NATIVE_CONTRACT_PORT: String(port) },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        exited = new Promise((resolve, reject) => {
          child.once("close", resolve);
          child.once("error", reject);
        });
        child.stderr.resume();
        return child;
      },
    };
    sdk = query({ prompt: input, options });
    interrupt = async () => {
      cancelled = true;
      cancellation.requested = true;
      cancellation.receipt = await sdk.interrupt();
      cancellation.accepted = true;
    };
    const account = await sdk.accountInfo();
    if (cancelAt === "initialization") {
      // Startup-input fence: initialization completes, but no user input was sent.
      // Adapter cancellation before query construction needs its own epoch guard.
      await interrupt();
      sdk.close();
      initialized();
      await exited;
      if (timedOut) throw new Error("Native initialization cancellation exceeded its deadline.");
      cancellation.drained = true;
      return {
        account,
        cancellation,
        requestCount,
        compaction: {
          hasSummary: false,
          providerRequests: compactProviderRequests,
          ordinaryAssistantContinuation: false,
        },
      };
    }
    for await (const message of sdk) {
      messages.push(message);
      if (message.type !== "result") continue;
      if (withCompact && preCompactSource === undefined) {
        const root = (await files(config)).find((path) => basename(path) === `${sessionId}.jsonl`);
        if (!root || !beginCompact)
          throw new Error("Cannot admit compaction after its first native result.");
        const fd = await open(root, "r");
        await fd.sync();
        await fd.close();
        preCompactSource = await readFile(root, "utf8");
        preCompactMessageCount = messages.length;
        if (cancelAt === "before-enqueue") {
          // Caller-side fence: an accepted interrupt cannot revoke future input.
          await interrupt();
          break;
        }
        compactAdmitted = true;
        beginCompact();
      } else break;
    }
    release?.();
    sdk.close();
    await exited;
    cancellation.drained = cancellation.requested;
    await interruptTask;
    if (interruptError) throw interruptError;
    if (timedOut) throw new Error("Native contract exceeded its owned deadline.");
    if (unexpectedRequest) throw new Error(`Unexpected local request: ${unexpectedRequest}`);
    let allFiles = await files(config);
    const rootPath = allFiles.find((path) => basename(path) === `${sessionId}.jsonl`);
    if (!rootPath)
      throw new Error(
        `No native transcript; received message types: ${messages.map((message) => message.type).join(",")}`,
      );
    const fd = await open(rootPath, "r");
    await fd.sync();
    await fd.close();
    await onRoot?.({ home, rootPath, sessionId, submittedUuid, compactUuid });
    let source = await readFile(rootPath, "utf8");
    let restart;
    if (withRestart) {
      const prefix = source;
      const childSnapshot = async () =>
        Promise.all(
          (await files(config))
            .filter((path) => path.includes("/subagents/") && path.endsWith(".jsonl"))
            .sort()
            .map(async (path) => [path, await readFile(path, "utf8")]),
        );
      const beforeChildren = await childSnapshot();
      const continuation = await withRestart({ home, rootPath, sessionId, submittedUuid });
      if (typeof continuation !== "string" || continuation.length === 0)
        throw new Error("Restart requires explicit synthetic continuation content.");
      const continuationUuid = randomUUID();
      const restartMessages = [];
      const restartInput = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "user",
            uuid: continuationUuid,
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { role: "user", content: continuation },
          };
          await new Promise((resolve) => {
            release = resolve;
          });
        },
      };
      const { sessionId: _initialSessionId, ...resumeOptions } = options;
      restarting = true;
      sdk = query({ prompt: restartInput, options: { ...resumeOptions, resume: sessionId } });
      await sdk.accountInfo();
      for await (const message of sdk) {
        restartMessages.push(message);
        if (message.type === "result") break;
      }
      release?.();
      sdk.close();
      await exited;
      if (timedOut) throw new Error("Native restart contract exceeded its owned deadline.");
      if (unexpectedRequest) throw new Error(`Unexpected local request: ${unexpectedRequest}`);
      source = await readFile(rootPath, "utf8");
      allFiles = await files(config);
      const restartResult = restartMessages.find((message) => message.type === "result");
      restart = {
        requestCount: restartRequests.length,
        requestMessages: restartRequests[0],
        prefixPreserved: source.startsWith(prefix),
        childFilesUnchanged:
          JSON.stringify(beforeChildren) === JSON.stringify(await childSnapshot()),
        childMessageCount: restartMessages.filter((message) => message.parent_tool_use_id != null)
          .length,
        taskStartedCount: restartMessages.filter(
          (message) => message.type === "system" && message.subtype === "task_started",
        ).length,
        toolUseCount: restartMessages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.message.content)
          .filter((block) => block.type === "tool_use").length,
        continuationCount: source
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (record) =>
              record.type === "user" &&
              record.uuid === continuationUuid &&
              record.message?.content === continuation,
          ).length,
        result: { subtype: restartResult?.subtype, isError: restartResult?.is_error },
      };
    }
    const records = source
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const user =
      records.find(
        (record) =>
          record.type === "user" &&
          record.message?.content === "Run the fixed Bash contract marker, then finish.",
      ) ??
      records.find(
        (record) =>
          record.type === "user" &&
          !record.message?.content?.some?.((block) => block.type === "tool_result"),
      );
    const childPaths = allFiles.filter(
      (path) => path.includes("/subagents/") && path.endsWith(".jsonl"),
    );
    const childNativeAssistantUuids = (
      await Promise.all(
        childPaths.map(async (path) => {
          const fd = await open(path, "r");
          await fd.sync();
          await fd.close();
          return (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((record) => record.type === "assistant")
            .map((record) => record.uuid);
        }),
      )
    ).flat();
    const childAssistantUuids = messages
      .filter((message) => message.type === "assistant" && message.parent_tool_use_id !== null)
      .map((message) => message.uuid);
    const toolRecords = records.filter(
      (record) =>
        record.type === "user" &&
        Array.isArray(record.message?.content) &&
        record.message.content.some((block) => block.type === "tool_result"),
    );
    const streamTools = messages.filter(
      (message) =>
        message.type === "user" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some((block) => block.type === "tool_result"),
    );
    return {
      account,
      restart,
      requestCount,
      requestSettings,
      sessionId,
      submittedUuid,
      userUuid: user?.uuid,
      cancellation,
      compaction: {
        customInstructionsReachedProvider,
        statuses: messages
          .slice(preCompactMessageCount)
          .filter((message) => message.type === "system" && message.subtype === "status")
          .map((message) => ({
            status: message.status,
            compactResult: message.compact_result ?? null,
            hasCompactError: Boolean(message.compact_error),
          })),
        publicPartialEvents: messages
          .slice(preCompactMessageCount)
          .filter((message) => message.type === "stream_event").length,
        boundaryContentIsSummary: (() => {
          const boundary = records.find((record) => record.subtype === "compact_boundary");
          const summary = records.find((record) => record.isCompactSummary === true);
          return Boolean(boundary && summary && boundary.content === summary.message?.content);
        })(),
        providerRequests: compactProviderRequests,
        ordinaryAssistantContinuation: records.some(
          (record) =>
            record.type === "assistant" &&
            preCompactSource !== undefined &&
            !preCompactSource.includes(record.uuid),
        ),
        commandEchoCount: records.filter(
          (record) =>
            record.type === "user" && JSON.stringify(record.message?.content).includes("/compact"),
        ).length,
        summary: (() => {
          const record = records.find((record) => record.isCompactSummary === true);
          return record
            ? {
                type: record.type,
                isCompactSummary: record.isCompactSummary,
                isVisibleInTranscriptOnly: record.isVisibleInTranscriptOnly,
                hasContent: Boolean(record.message?.content?.length),
              }
            : null;
        })(),
        prefixPreserved: preCompactSource !== undefined && source.startsWith(preCompactSource),
        hasBoundary: records.some(
          (record) => record.type === "system" && record.subtype === "compact_boundary",
        ),
        hasSummary: records.some((record) => record.isCompactSummary === true),
        metadataKeys: Object.keys(
          records.find((record) => record.subtype === "compact_boundary")?.compactMetadata ?? {},
        ).sort(),
        boundaryKeys: Object.keys(
          records.find((record) => record.subtype === "compact_boundary") ?? {},
        ).sort(),
        summaryKeys: Object.keys(
          records.find((record) => record.isCompactSummary === true) ?? {},
        ).sort(),
      },
      assistantUuids: records
        .filter((record) => record.type === "assistant")
        .map((record) => record.uuid),
      streamAssistantUuids: messages
        .filter((message) => message.type === "assistant")
        .map((message) => message.uuid),
      toolResultUuids: toolRecords.map((record) => record.uuid),
      streamToolResultUuids: streamTools.map((message) => message.uuid),
      toolOutput: toolRecords
        .flatMap((record) => record.message.content)
        .find((block) => block.type === "tool_result")?.content,
      rootFile: basename(rootPath),
      rootHasTrailingNewline: source.endsWith("\n"),
      projectKeyMatchesCwd: basename(dirname(rootPath)) === cwd.replace(/[^a-zA-Z0-9]/g, "-"),
      sdkVersion: JSON.parse(
        await readFile(
          join(
            dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")),
            "package.json",
          ),
          "utf8",
        ),
      ).version,
      cliVersion: messages.find(
        (message) => message.type === "system" && message.subtype === "init",
      )?.claude_code_version,
      childFiles: childPaths.map((path) => basename(path)),
      childAssistantUuids,
      childNativeAssistantUuids,
      rootContainsChildAssistant: records.some((record) =>
        childNativeAssistantUuids.includes(record.uuid),
      ),
      effectiveModel: messages.find(
        (message) => message.type === "system" && message.subtype === "init",
      )?.model,
      nativeEfforts: records
        .filter((record) => record.type === "assistant")
        .map((record) => record.perTurnEffort),
      result: {
        subtype: messages.find((message) => message.type === "result")?.subtype,
        isError: messages.find((message) => message.type === "result")?.is_error,
      },
      conversationShapes: records
        .filter((record) => record.type === "user" || record.type === "assistant")
        .map((record) => ({
          type: record.type,
          keys: Object.keys(record).sort(),
          messageKeys: Object.keys(record.message).sort(),
        })),
      nativeShapes: records.map((record) => ({
        type: record.type,
        subtype: record.subtype,
        keys: Object.keys(record).sort(),
        messageKeys: record.message ? Object.keys(record.message).sort() : undefined,
      })),
      streamShapes: messages
        .filter((message) => message.type !== "stream_event")
        .map((message) => ({
          type: message.type,
          subtype: message.subtype,
          keys: Object.keys(message).sort(),
        })),
    };
  } finally {
    clearTimeout(timer);
    cancelled = true;
    initialized();
    releaseQueuedHook();
    enterCompact();
    queuedDelivered();
    beginCompact?.();
    release?.();
    sdk?.close();
    if (child && child.exitCode === null && child.signalCode === null) killOwnedGroup();
    if (exited) await exited.catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}

/** Verify denied destinations never reach connect(), before any native probe. */
export async function probeNetworkGuard() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const code = `import errno,json,os,socket
port=int(os.environ['NATIVE_CONTRACT_PORT'])
def connects(host,p):
 s=socket.socket();s.settimeout(1)
 try:
  s.connect((host,p));return 'allowed'
 except OSError as error:
  return 'denied' if error.errno == errno.EPERM else 'other-error'
 finally:
  s.close()
local=connects('127.0.0.1',port)=='allowed'
external=connects('192.0.2.1',port)=='denied'
other=connects('127.0.0.1',1)=='denied'
try:
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.close();udp=False
except OSError as error:
 udp=error.errno==errno.EPERM
print(json.dumps(dict(localAllowed=local,externalDenied=external,otherPortDenied=other,udpDenied=udp)))`;
  const child = spawn(
    "/usr/bin/python3",
    [
      fileURLToPath(new URL("./network-guard.py", import.meta.url)),
      "/usr/bin/python3",
      "-I",
      "-c",
      code,
    ],
    {
      cwd: tmpdir(),
      env: {
        HOME: "/nonexistent",
        PATH: "/usr/bin:/bin",
        NATIVE_CONTRACT_PORT: String(port),
      },
      detached: true,
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 5_000);
  try {
    const [exitCode] = await once(child, "close");
    if (exitCode !== 0) throw new Error("Network-guard self-test failed.");
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
