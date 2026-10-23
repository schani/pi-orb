import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

export async function probePassiveBootContext(marker) {
  const home = await mkdtemp(join(tmpdir(), "claude-boot-context-"));
  const cwd = join(home, "workspace"),
    config = join(home, "config");
  await mkdir(cwd);
  await mkdir(config);
  const requests = [],
    children = [],
    childExits = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/hello") {
      res.end();
      return;
    }
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      if (req.url?.split("?")[0] === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":16}');
        return;
      }
      if (req.url?.split("?")[0] !== "/v1/messages") {
        res.writeHead(404);
        res.end();
        return;
      }
      requests.push(JSON.parse(text));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit("message_start", {
        message: {
          id: "msg_boot_context",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 16, output_tokens: 0 },
        },
      });
      emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Boot context observed." },
      });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 8 },
      });
      emit("message_stop", {});
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const sessionId = randomUUID(),
    bootUuid = randomUUID();

  const nativePath = join(
    config,
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  let live;
  const deadline = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    live?.close();
  }, 25000);
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
  };
  async function run(inputs, resume = false, id = sessionId) {
    let child, exited;
    const sdk = query({
      prompt: {
        async *[Symbol.asyncIterator]() {
          for (const input of inputs) yield input;
        },
      },
      options: {
        cwd,
        env,
        ...(resume ? { resume: id } : { sessionId: id }),
        settingSources: [],
        tools: [],
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
              fileURLToPath(new URL("./network-guard.py", import.meta.url)),
              options.command,
              ...options.args,
            ],
            {
              cwd: options.cwd,
              env: { ...env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", NATIVE_CONTRACT_PORT: String(port) },
              detached: true,
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          children.push(child);
          child.stderr.resume();
          exited = once(child, "close");
          childExits.push(exited);
          return child;
        },
      },
    });
    live = sdk;
    await sdk.accountInfo();
    const messages = [];
    for await (const message of sdk) messages.push(message);
    const [code, signal] = await exited;
    if (code !== 0) throw new Error(`Native boot context process failed: ${code ?? signal}`);
    sdk.close();
    live = null;
    return messages;
  }
  try {
    const input = {
      type: "user",
      uuid: bootUuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
      shouldQuery: false,
      message: { role: "user", content: marker },
    };
    await run([input]);
    const passiveSource = await readFile(nativePath, "utf8");
    const passive = passiveSource.trim().split("\n").map(JSON.parse);
    const passiveRequests = requests.length;
    await run([], true);
    const metadataRequests = requests.length - passiveRequests;
    await run(
      [
        {
          type: "user",
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          priority: "now",
          origin: { kind: "human" },
          message: { role: "user", content: "NEW_HUMAN_CONTRACT_TASK" },
        },
      ],
      true,
    );
    const humanRequests = requests.length - passiveRequests - metadataRequests;
    const afterHuman = (await readFile(nativePath, "utf8")).trim().split("\n").map(JSON.parse);
    const fifoSessionId = randomUUID(),
      fifoBootUuid = randomUUID(),
      humanUuid = randomUUID();
    const fifoStart = requests.length;
    const fifo = await run(
      [
        { ...input, uuid: fifoBootUuid, session_id: fifoSessionId },
        {
          type: "user",
          uuid: humanUuid,
          session_id: fifoSessionId,
          parent_tool_use_id: null,
          priority: "now",
          origin: { kind: "human" },
          message: { role: "user", content: "FIFO_HUMAN_TASK" },
        },
      ],
      false,
      fifoSessionId,
    );
    return {
      passiveRequests,
      metadataRequests,
      humanRequests,
      passiveBootEntries: passive.filter((x) => x.uuid === bootUuid),
      passiveAssistantEntries: passive.filter((x) => x.type === "assistant"),
      afterHumanBootEntries: afterHuman.filter((x) => x.uuid === bootUuid),
      humanMessages: requests[fifoStart - 1]?.messages,
      fifoRequests: requests.length - fifoStart,
      fifoMessages: requests.at(-1)?.messages,
      fifoResults: fifo.filter((x) => x.type === "result"),
      fifoBootUuid,
      humanUuid,
      cliVersion: passive.find((x) => x.uuid === bootUuid)?.version,
    };
  } finally {
    clearTimeout(deadline);
    live?.close();
    for (const child of children)
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    await Promise.all(childExits);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}
