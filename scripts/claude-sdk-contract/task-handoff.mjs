import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Real pinned CLI, real background Bash, fixed loopback inference; no provider credentials.
export async function probeTaskHandoff({ cwd, configDir, sessionId, input, release, onMessage }) {
  const home = await mkdtemp(join(tmpdir(), "native-task-handoff-"));
  const gates = [join(cwd, "gate1"), join(cwd, "gate2")];
  await mkdir(configDir, { recursive: true });
  execFileSync("mkfifo", gates);
  let requests = 0;
  let unexpected;
  let timedOut = false;
  let closing = false;
  let acknowledgments = 0;
  let closedAtAcknowledgment = false;
  let rootActivityAfterClose = false;
  let firstResult = true;
  let heldResponse;
  let terminalNotifications = 0;
  let releaseWrites = Promise.resolve();
  let releaseError;
  let child;
  let sdk;
  let exited;
  let endInput;
  const inputEnd = new Promise((resolve) => {
    endInput = resolve;
  });
  const inputSource = {
    async *[Symbol.asyncIterator]() {
      yield input;
      await inputEnd;
    },
  };
  function reply(res, blocks) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, fields) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("message_start", {
      message: {
        id: `msg_handoff_${requests}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 16, output_tokens: 0 },
      },
    });
    for (const [index, block] of blocks.entries()) {
      emit("content_block_start", {
        index,
        content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
      });
      emit("content_block_delta", {
        index,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
      emit("content_block_stop", { index });
    }
    emit("message_delta", {
      delta: {
        stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 8 },
    });
    emit("message_stop", {});
    res.end();
  }
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/v1/messages") {
      req.resume();
      req.once("end", () => {
        requests++;
        if (requests === 1)
          reply(
            res,
            gates.map((gate, i) => ({
              type: "tool_use",
              id: `toolu_background_${i}`,
              name: "Bash",
              input: {
                command: `cat '${gate}'`,
                run_in_background: true,
                description: "fixed background command",
              },
            })),
          );
        else if (requests === 2) {
          if (release === "during-response") {
            heldResponse = res;
            releaseWrites = Promise.all(gates.map((gate) => writeFile(gate, "done\n"))).catch(
              (error) => {
                releaseError = error;
                sdk?.close();
                kill();
              },
            );
          } else reply(res, [{ type: "text", text: "Waiting for the two commands." }]);
        } else if (requests === 3)
          reply(res, [
            {
              type: "tool_use",
              id: "toolu_foreground",
              name: "Bash",
              input: { command: "printf fixed-output", description: "fixed foreground command" },
            },
          ]);
        else reply(res, [{ type: "text", text: "Completed." }]);
      });
    } else if (path === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":16}');
    } else if (req.method === "HEAD" && path === "/api/hello") {
      res.writeHead(200);
      res.end();
    } else {
      unexpected = `${req.method} ${path}`;
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  function kill() {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    sdk?.close();
    kill();
  }, 20_000);
  try {
    sdk = query({
      prompt: inputSource,
      options: {
        cwd,
        sessionId,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "dummy-native-contract-not-a-real-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
        },
        settingSources: [],
        tools: ["Bash"],
        plugins: [],
        model: "claude-sonnet-5-5",
        effort: "low",
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        spawnClaudeCodeProcess: (options) => {
          child = spawn(
            "/usr/bin/python3",
            [
              join(dirname(fileURLToPath(import.meta.url)), "network-guard.py"),
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
          exited = once(child, "close");
          child.stderr.resume();
          return child;
        },
      },
    });
    await sdk.accountInfo();
    for await (const message of sdk) {
      if (message.type === "system" && message.subtype === "task_notification") {
        terminalNotifications++;
        if (terminalNotifications === 2 && heldResponse !== undefined) {
          reply(heldResponse, [{ type: "text", text: "Background commands completed." }]);
          heldResponse = undefined;
        }
      }
      const acknowledgment = message.type === "result" && message.num_turns === 0;
      if (acknowledgment) acknowledgments++;
      if (
        closing &&
        ((message.type === "system" &&
          message.subtype === "status" &&
          message.status === "requesting") ||
          (message.type === "assistant" && message.parent_tool_use_id === null))
      )
        rootActivityAfterClose = true;
      if (await onMessage(message)) {
        if (!closing) closedAtAcknowledgment = acknowledgment;
        closing = true;
        endInput();
      }
      if (message.type === "result" && firstResult) {
        firstResult = false;
        if (release === "after-result")
          await Promise.all(gates.map((gate) => writeFile(gate, "done\n")));
      }
    }
    await exited;
    await releaseWrites;
    if (releaseError) throw releaseError;
    if (timedOut) throw new Error("Native task-handoff deadline expired.");
    if (unexpected) throw new Error(`Unexpected native request: ${unexpected}`);
    return { requests, acknowledgments, closedAtAcknowledgment, rootActivityAfterClose };
  } finally {
    clearTimeout(timer);
    endInput();
    sdk?.close();
    kill();
    await exited?.catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(gates.map((gate) => rm(gate, { force: true })));
    await rm(home, { recursive: true, force: true });
  }
}
