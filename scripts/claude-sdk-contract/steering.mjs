import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";

function latch() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startResponse(response, block) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", {
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 16, output_tokens: 0 },
    },
  });
  emit("content_block_start", {
    index: 0,
    content_block:
      block.type === "text"
        ? { type: "text", text: "" }
        : block.type === "thinking"
          ? { type: "thinking", thinking: "", signature: "" }
          : { ...block, input: {} },
  });
  emit("content_block_delta", {
    index: 0,
    delta:
      block.type === "thinking"
        ? { type: "thinking_delta", thinking: "Controlled thinking in flight." }
        : block.type === "text"
          ? { type: "text_delta", text: block.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
  });
  return () => {
    emit("content_block_stop", { index: 0 });
    emit("message_delta", {
      delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    });
    emit("message_stop", {});
    response.end();
  };
}

/** Genuine pinned SDK/CLI; owned loopback provider, explicit barriers, no agents or credentials. */
export async function probeSteering(mode, onMessage, nextInput) {
  const home = await mkdtemp(join(tmpdir(), "claude-steering-contract-"));
  const cwd = join(home, "workspace");
  const config = join(home, "config");
  await mkdir(cwd);
  await mkdir(config);
  const ready = latch();
  const releaseTool = latch();
  const endInput = latch();
  const sessionId = randomUUID();
  const rootPath = join(
    config,
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  let firstUuid = randomUUID();
  let steerUuid = randomUUID();
  const marker = "NATIVE_STEER_CHANGE_COURSE";
  let toolCompleted = false;
  let steeredWhileToolBlocked = false;
  let requests = 0;
  let unexpectedRequest;
  let heldResponse;
  const results = [];
  const events = [];
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url?.split("?")[0] === "/v1/messages") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body);
        requests++;
        const steering = JSON.stringify(payload.messages).includes(marker);
        if (steering) {
          steeredWhileToolBlocked ||= mode === "tool" && !toolCompleted;
          releaseTool.resolve();
        }
        if (requests === 1 && (mode === "tool" || mode === "tool-thinking")) {
          startResponse(response, {
            type: "tool_use",
            id: "toolu_steering_hold",
            name: "mcp__steering__hold",
            input: {},
          })();
        } else if (requests === 1 || (requests === 2 && mode === "tool-thinking")) {
          heldResponse = response;
          startResponse(response, {
            type: mode === "thinking" || mode === "tool-thinking" ? "thinking" : "text",
            text: "Initial response is still streaming.",
          });
        } else {
          startResponse(response, { type: "text", text: "Steering acknowledged." })();
        }
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
  const input = {
    async *[Symbol.asyncIterator]() {
      const first = nextInput ? await nextInput("first", { sessionId, marker }) : undefined;
      if (first) firstUuid = first.uuid;
      yield first ?? {
        type: "user",
        uuid: firstUuid,
        parent_tool_use_id: null,
        priority: "now",
        origin: { kind: "human" },
        message: { role: "user", content: "Run the fixed tool, then finish." },
      };
      await ready.promise;
      const steer = nextInput ? await nextInput("steer", { sessionId, marker }) : undefined;
      if (steer) steerUuid = steer.uuid;
      yield steer ?? {
        type: "user",
        uuid: steerUuid,
        parent_tool_use_id: null,
        priority: "now",
        origin: { kind: "human" },
        message: { role: "user", content: marker },
      };
      await endInput.promise;
    },
  };
  let child;
  let exited;
  let sdk;
  let timedOut = false;
  const killGroup = () => {
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
    releaseTool.resolve();
    endInput.resolve();
    killGroup();
  }, 20_000);
  try {
    sdk = query({
      prompt: input,
      options: {
        cwd,
        sessionId,
        settingSources: [],
        tools: [],
        plugins: [],
        model: "claude-sonnet-5-5",
        effort: "low",
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers:
          mode === "tool" || mode === "tool-thinking"
            ? {
                steering: createSdkMcpServer({
                  name: "steering",
                  tools: [
                    tool("hold", "Fixed blocked native steering contract", {}, async () => {
                      if (mode === "tool") {
                        ready.resolve();
                        await releaseTool.promise;
                      }
                      toolCompleted = true;
                      return { content: [{ type: "text", text: "Fixed tool completed." }] };
                    }),
                  ],
                }),
              }
            : {},
        env: {
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
        },
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
      },
    });
    for await (const message of sdk) {
      events.push(message);
      if (onMessage) await onMessage(message);
      if (
        mode !== "tool" &&
        message.type === "stream_event" &&
        message.event.type === "content_block_delta" &&
        (mode !== "tool-thinking" || message.event.delta.type === "thinking_delta")
      )
        ready.resolve();
      if (message.type !== "result") continue;
      results.push({
        subtype: message.subtype,
        isError: message.is_error,
        answersFirst: (message.user_message_uuids ?? [message.user_message_uuid]).includes(
          firstUuid,
        ),
        answersSteer: (message.user_message_uuids ?? [message.user_message_uuid]).includes(
          steerUuid,
        ),
      });
      if (results.at(-1).answersSteer) {
        endInput.resolve();
        break;
      }
    }
    endInput.resolve();
    releaseTool.resolve();
    sdk.close();
    await exited;
    if (timedOut)
      throw new Error(
        `Native steering ${mode} exceeded its owned deadline: ${JSON.stringify({ requests, results, steeredWhileToolBlocked })}`,
      );
    if (unexpectedRequest) throw new Error(`Unexpected local request: ${unexpectedRequest}`);
    const root = { source: await readFile(rootPath, "utf8"), sessionId, steerUuid };
    return { requests, results, steeredWhileToolBlocked, toolCompleted, root, events };
  } finally {
    clearTimeout(timer);
    ready.resolve();
    endInput.resolve();
    releaseTool.resolve();
    heldResponse?.destroy();
    sdk?.close();
    killGroup();
    await exited?.catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}
