import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

export async function withOrphanMonitor({ cwd, configDir: config, sessionId, artifactName, run }) {
  const artifactRoot = process.env.CLAUDE_UNOWNED_ARTIFACT_DIR;
  const artifact = artifactRoot === undefined ? undefined : join(artifactRoot, artifactName);
  if (artifact !== undefined) await mkdir(artifact, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "native-natural-monitor-"));
  await mkdir(config, { recursive: true });
  const gate = join(cwd, "task-gate");
  execFileSync("mkfifo", [gate]);
  const fd = openSync(gate, constants.O_RDWR | constants.O_NONBLOCK);
  const events = [];
  let phase = "warmup";
  let requests = 0;
  let child,
    sdk,
    exited,
    unexpected,
    timedOut = false;
  let releaseWarmup;
  const warmupEnd = new Promise((resolve) => {
    releaseWarmup = resolve;
  });
  function reply(res, blocks) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, fields) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("message_start", {
      message: {
        id: `msg_orphan_${requests}`,
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
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.once("end", () => {
        requests++;
        events.push({ type: "provider-request", phase, ordinal: requests, body: JSON.parse(text) });
        if (requests === 1)
          reply(res, [
            {
              type: "tool_use",
              id: "toolu_orphan_background",
              name: "Monitor",
              input: {
                command: `read -r fixed < '${gate}'`,
                timeout_ms: 1800000,
                description: "Fixed orphan fixture task",
              },
            },
          ]);
        else
          reply(res, [
            {
              type: "text",
              text: phase === "warmup" ? "Waiting for the fixture task." : "Fixed resumed answer.",
            },
          ]);
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
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const options = {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: home,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-native-contract-not-a-real-token",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
    settingSources: [],
    tools: ["Monitor"],
    plugins: [],
    model: "claude-sonnet-5-5",
    effort: "low",
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    spawnClaudeCodeProcess: wrapSpawn(),
  };
  function wrapSpawn(original) {
    return (opts) => {
      const guarded = {
        ...opts,
        command: original === undefined ? "/usr/bin/python3" : "/usr/bin/setsid",
        args: [
          ...(original === undefined ? [] : ["/usr/bin/python3"]),
          join(dirname(fileURLToPath(import.meta.url)), "network-guard.py"),
          opts.command,
          ...opts.args,
        ],
        env: { ...opts.env, NATIVE_CONTRACT_PORT: String(port) },
      };
      child =
        original === undefined
          ? spawn(guarded.command, guarded.args, {
              cwd: opts.cwd,
              env: guarded.env,
              detached: true,
              stdio: ["pipe", "pipe", "pipe"],
            })
          : original(guarded);
      events.push({ type: "spawn", phase, command: opts.command, args: opts.args });
      exited = once(child, "close").then(([code, signal]) => {
        events.push({ type: "native-process-closed", phase, code, signal });
      });
      child.stderr.on("data", (chunk) =>
        events.push({ type: "stderr", phase, text: chunk.toString() }),
      );
      return child;
    };
  }
  function cancel() {
    sdk?.close();
    kill();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 20_000);
  let taskId;
  let runResult;
  try {
    sdk = query({
      prompt: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "user",
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            origin: { kind: "human" },
            message: { role: "user", content: "Start the fixed background fixture task." },
          };
          await warmupEnd;
        },
      },
      options: { ...options, sessionId },
    });
    await sdk.accountInfo();
    for await (const message of sdk) {
      events.push({ type: "sdk-output", phase, message });
      if (message.type === "system" && message.subtype === "task_started") taskId = message.task_id;
      if (message.type === "result") {
        if (!(message.num_turns > 0) || taskId === undefined)
          throw new Error("Native Monitor warmup did not start a task.");
        events.push({ type: "kill-native", phase });
        kill();
        await exited;
        if (artifact !== undefined)
          await cp(config, join(artifact, "warmup-config"), { recursive: true });
        break;
      }
    }
    sdk.close();
    releaseWarmup();
    writeSync(fd, "done\n");
    phase = "resume";
    runResult = await run({
      env: options.env,
      wrapSpawn,
      events,
      trackQuery: (query) => {
        sdk = query;
      },
      cancel,
    });
    if (timedOut) throw new Error("Native Monitor fixture deadline expired.");
    if (unexpected) throw new Error(`Unexpected fixture request: ${unexpected}`);
    if (artifact !== undefined)
      await cp(config, join(artifact, "resumed-config"), { recursive: true });
    return { taskId, runResult, events };
  } finally {
    clearTimeout(timer);
    releaseWarmup();
    sdk?.close();
    kill();
    writeSync(fd, "done\n");
    closeSync(fd);
    await exited?.catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (artifact !== undefined)
      await writeFile(
        join(artifact, "events.json"),
        JSON.stringify({ taskId, runResult, events }, null, 2),
      );
    await rm(home, { recursive: true, force: true });
  }
}
