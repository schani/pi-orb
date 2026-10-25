import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Real pinned CLI, real background Bash, fixed loopback inference; no provider credentials.
export async function probeTaskHandoff({
  cwd,
  configDir,
  sessionId,
  input,
  release,
  onMessage,
  terminalFailure = false,
  onQuery,
  spawnProcess,
}) {
  const home = await mkdtemp(join(tmpdir(), "native-task-handoff-"));
  const gates = [join(cwd, "gate1"), join(cwd, "gate2")];
  await mkdir(configDir, { recursive: true });
  execFileSync("mkfifo", gates);
  let requests = 0;
  let responses = 0;
  let continuationAborted = false;
  let continuationHeld = false;
  let requestContinuation;
  let closeContinuation;
  let stopContinuation;
  const continuationUnavailable = new Promise((resolve) => {
    stopContinuation = resolve;
  });
  const continuationRequested = new Promise((resolve) => {
    requestContinuation = resolve;
  });
  const continuationClosed = new Promise((resolve) => {
    closeContinuation = resolve;
  });
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
  let interruptions = 0;
  let interruptReceipt;
  let nativeExit = false;
  let exitCode;
  let exitSignal;
  let failedResult = false;
  let nativeError;
  let capabilities;
  let cliVersion;
  let stdoutEOF = false;
  let processGroupOwned = false;
  const trace = [];
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
    responses++;
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
  function rootReply(res) {
    if (!terminalFailure) {
      reply(res, [{ type: "text", text: "Background commands completed." }]);
      return;
    }
    responses++;
    res.writeHead(429, { "content-type": "application/json", "x-should-retry": "false" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Fixed native refusal." },
      }),
    );
  }
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/v1/messages") {
      req.resume();
      req.once("end", () => {
        requests++;
        trace.push({ edge: "provider_request", request: requests, closing });
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
          } else if (terminalFailure) rootReply(res);
          else reply(res, [{ type: "text", text: "Waiting for the two commands." }]);
        } else if (terminalFailure) {
          continuationHeld = true;
          trace.push({ edge: "continuation_response_held", request: requests, closing });
          res.once("close", () => {
            continuationAborted = !res.writableEnded;
            trace.push({
              edge: "continuation_response_closed",
              aborted: continuationAborted,
              closing,
            });
            closeContinuation();
          });
          requestContinuation();
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
    stopContinuation(new Error("Native task-handoff deadline expired."));
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
          ...(terminalFailure ? { CLAUDE_CODE_MAX_RETRIES: "0" } : {}),
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
          const args = [
            join(dirname(fileURLToPath(import.meta.url)), "network-guard.py"),
            options.command,
            ...options.args,
          ];
          const env = { ...options.env, NATIVE_CONTRACT_PORT: String(port) };
          child =
            spawnProcess === undefined
              ? spawn("/usr/bin/python3", args, {
                  cwd: options.cwd,
                  env,
                  detached: true,
                  stdio: ["pipe", "pipe", "pipe"],
                })
              : spawnProcess({
                  ...options,
                  command: "/usr/bin/setsid",
                  args: ["/usr/bin/python3", ...args],
                  env,
                });
          if (terminalFailure)
            child.stdout.once("end", () => {
              stdoutEOF = true;
              trace.push({ edge: "stdout_eof" });
            });
          child.once("exit", (code, signal) => {
            trace.push({ edge: "process_exit", code, signal });
            stopContinuation(new Error("Native exited before requesting the continuation."));
          });
          child.once("error", stopContinuation);
          exited = new Promise((resolve) => {
            child.once("close", (code, signal) => {
              nativeExit = true;
              exitCode = code;
              exitSignal = signal;
              stopContinuation(new Error("Native exited before requesting the continuation."));
              resolve();
            });
          });
          child.stderr.resume();
          return child;
        },
      },
    });
    await sdk.accountInfo();
    if (terminalFailure) {
      const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
      processGroupOwned = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === child.pid;
      if (!processGroupOwned) throw new Error("Native process group is not owned.");
    }
    onQuery?.({
      interrupt: async (options) => {
        interruptions++;
        trace.push({ edge: "interrupt_requested", options, closing });
        interruptReceipt = await sdk.interrupt(options);
        trace.push({ edge: "interrupt_receipt", receipt: interruptReceipt, closing });
        return interruptReceipt;
      },
      requestShutdown: () => {
        trace.push({ edge: "shutdown_requested", closing });
        closing = true;
        endInput();
      },
    });
    try {
      for await (const message of sdk) {
        if (message.type !== "stream_event")
          trace.push({
            edge: "message",
            type: message.type,
            subtype: message.subtype,
            status: message.status,
            id: message.uuid,
            taskId: message.task_id,
            isError: message.is_error,
            numTurns: message.num_turns,
            closing,
          });
        if (message.type === "system" && message.subtype === "init") {
          capabilities = message.capabilities;
          cliVersion = message.claude_code_version;
        }
        if (message.type === "result" && (message.is_error || message.subtype !== "success"))
          failedResult = true;
        if (message.type === "system" && message.subtype === "task_notification") {
          terminalNotifications++;
          if (terminalNotifications === 2 && heldResponse !== undefined) {
            rootReply(heldResponse);
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
        if (
          terminalFailure &&
          release === "during-response" &&
          firstResult &&
          message.type === "result"
        ) {
          const unavailable = await Promise.race([continuationRequested, continuationUnavailable]);
          if (unavailable !== undefined) throw unavailable;
          trace.push({ edge: "failed_result_forwarded", id: message.uuid, closing });
        }
        if (await onMessage(message)) {
          if (!closing) closedAtAcknowledgment = acknowledgment;
          closing = true;
          endInput();
        }
        if (message.type === "result" && firstResult) {
          firstResult = false;
          if (release === "after-result" && !terminalFailure)
            await Promise.all(gates.map((gate) => writeFile(gate, "done\n")));
        }
      }
    } catch (error) {
      nativeError = error;
      trace.push({
        edge: "iterator_error",
        errorClass: error.errorClass,
        exitCode: error.exitCode,
      });
      if (
        !terminalFailure ||
        !failedResult ||
        (error.errorClass !== "process_exited_nonzero" && error.errorClass !== "error_result")
      )
        throw error;
    }
    await exited;
    if (continuationHeld) await continuationClosed;
    if (
      nativeError !== undefined &&
      !(
        failedResult &&
        exitCode === 1 &&
        exitSignal === null &&
        ((nativeError.errorClass === "process_exited_nonzero" && nativeError.exitCode === 1) ||
          nativeError.errorClass === "error_result")
      )
    )
      throw nativeError;
    await releaseWrites;
    if (releaseError) throw releaseError;
    if (timedOut) throw new Error("Native task-handoff deadline expired.");
    if (unexpected) throw new Error(`Unexpected native request: ${unexpected}`);
    return {
      requests,
      responses,
      continuationAborted,
      acknowledgments,
      closedAtAcknowledgment,
      rootActivityAfterClose,
      interruptions,
      interruptReceipt,
      terminalNotifications,
      nativeExit,
      stdoutEOF,
      processGroupOwned,
      trace,
      exitCode,
      exitSignal,
      capabilities,
      cliVersion,
      sdkVersion: JSON.parse(
        await readFile(
          join(
            dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")),
            "package.json",
          ),
          "utf8",
        ),
      ).version,
      iteratorError: nativeError,
    };
  } finally {
    clearTimeout(timer);
    endInput();
    sdk?.close();
    kill();
    await exited;
    await Promise.all(
      gates.map(async (gate) => {
        const fifo = await open(gate, constants.O_RDWR | constants.O_NONBLOCK);
        try {
          await fifo.writeFile("done\n");
        } finally {
          await fifo.close();
        }
      }),
    );
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(gates.map((gate) => rm(gate, { force: true })));
    await rm(home, { recursive: true, force: true });
  }
}
