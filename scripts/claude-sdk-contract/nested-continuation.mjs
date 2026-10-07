import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";

function sse(response, blocks) {
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
  blocks.forEach((block, index) => {
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
  });
  emit("message_delta", {
    delta: {
      stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 8 },
  });
  emit("message_stop", {});
  response.end();
}
const text = (value) => [{ type: "text", text: value }];
const agent = (id, type, prompt) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { subagent_type: type, prompt, description: type, run_in_background: true },
});
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
      ),
    )
  ).flat();
}

/** Real SDK/CLI, fake loopback provider, no inherited credentials or configuration. */
export async function probeNestedContinuation(options = {}) {
  const {
    closePolicy = "after-final-result",
    resumeReviewer = false,
    hookNestedForeground = false,
    releaseOrder = "forward",
    projectAgent,
    productionPreToolUse,
    nestedBackground,
    rootFanout = false,
  } = options;
  const home = await mkdtemp(join(tmpdir(), "claude-nested-contract-"));
  const cwd = join(home, "workspace");
  const config = join(home, "config");
  await mkdir(cwd);
  await mkdir(config);
  if (projectAgent) {
    const directory = join(cwd, ".claude", "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "contract-reviewer.md"),
      "---\nname: contract-reviewer\ndescription: Fixed reviewer\ntools: Agent, Bash\nmodel: inherit\n---\nNATIVE_CONTRACT_REVIEWER_SYSTEM\n",
    );
    if (rootFanout)
      await writeFile(
        join(directory, "contract-root-peer.md"),
        "---\nname: contract-root-peer\ndescription: Fixed root peer\nmodel: inherit\n---\nNATIVE_CONTRACT_ROOT_PEER_SYSTEM\n",
      );
    await writeFile(
      join(directory, `${projectAgent.name}.md`),
      `---\nname: ${projectAgent.name}\ndescription: Fixed leaf\nmodel: inherit\nbackground: ${projectAgent.background}\n---\nNATIVE_CONTRACT_LEAF_SYSTEM\n`,
    );
  }
  const effectiveBackground = Object.hasOwn(options, "nestedBackground") ? nestedBackground : true;
  const denialSchedule = Boolean(productionPreToolUse);
  const denialReasons = new Map();
  const providerDenials = new Map();
  let ordinaryToolResults = 0;
  const foregroundSchedule = hookNestedForeground && !projectAgent?.background;
  const events = [];
  const checkpoint = (type, fields = {}) =>
    events.push({ sequence: events.length, type, ...fields });
  const counts = { root: 0, reviewer: 0, leaf: 0 };
  let peerRequests = 0;
  let reviewerResponse;
  let peerResponse;
  const releaseRootFanout = () => {
    if (!reviewerResponse || !peerResponse) return;
    checkpoint("root-fanout-provider-barrier", { count: 2 });
    sse(peerResponse, text("Root peer complete."));
    sse(reviewerResponse.response, reviewerResponse.blocks);
    peerResponse = undefined;
    reviewerResponse = undefined;
  };
  const heldLeaves = [];
  let released = false;
  let inputEnded = false;
  let reviewerStopped = false;
  let rootSawReviewer = false;
  let allNestedSeen = false;
  let resumeSent = false;
  let rootSawFinal = false;
  let unexpectedRequest;
  const leafNotices = new Set();
  const leafReleaseOrder = releaseOrder === "forward" ? [0, 1, 2] : [2, 1, 0];
  const foregroundLeaves = new Map();
  let rootLaunchConsumed = false;
  let releasedForeground = 0;
  const releaseForegroundLeaf = () => {
    if (!rootLaunchConsumed || foregroundLeaves.size !== 3 || releasedForeground === 3) return;
    const index = leafReleaseOrder[releasedForeground++];
    checkpoint("release-nested-response", { index });
    sse(foregroundLeaves.get(index), text("Nested child complete."));
  };
  const releaseLeaves = () => {
    if (foregroundSchedule) {
      if (releasedForeground === 0) releaseForegroundLeaf();
      return;
    }
    if (released || !reviewerStopped || !rootSawReviewer || heldLeaves.length !== 3) return;
    if (closePolicy === "first-result" && !inputEnded) return;
    released = true;
    checkpoint("release-nested-responses");
    for (const response of heldLeaves) sse(response, text("Nested child complete."));
  };
  const server = createServer((request, response) => {
    const route = request.url?.split("?")[0];
    if (request.method === "POST" && route === "/v1/messages") {
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        source += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(source);
        source = "";
        const system = JSON.stringify(body.system);
        const lane = system.includes("NATIVE_CONTRACT_LEAF_SYSTEM")
          ? "leaf"
          : system.includes("NATIVE_CONTRACT_REVIEWER_SYSTEM")
            ? "reviewer"
            : "root";
        if (system.includes("NATIVE_CONTRACT_ROOT_PEER_SYSTEM")) {
          ++peerRequests;
          checkpoint("provider-request", { lane: "root-peer", turn: peerRequests });
          peerResponse = response;
          releaseRootFanout();
          return;
        }
        const turn = ++counts[lane];
        checkpoint("provider-request", { lane, turn });
        if (lane === "leaf") {
          if (denialSchedule)
            throw new Error("Production nested denial allowed descendant provider dispatch.");
          if (foregroundSchedule) {
            const content = JSON.stringify(body.messages);
            const index = [0, 1, 2].find((n) =>
              content.includes(`NATIVE_CONTRACT_LEAF_INPUT_${n}`),
            );
            if (index === undefined) throw new Error("Unclassified fixed nested request.");
            foregroundLeaves.set(index, response);
          } else heldLeaves.push(response);
          releaseLeaves();
        } else if (lane === "reviewer") {
          if (denialSchedule && turn > 1) {
            const results = body.messages
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .filter(
                (block) =>
                  block.type === "tool_result" && /^toolu_nested_[012]$/.test(block.tool_use_id),
              );
            const expectedIds = [0, 1, 2].map((n) => `toolu_nested_${n}`);
            if (
              results.length !== 3 ||
              new Set(results.map((block) => block.tool_use_id)).size !== 3 ||
              !expectedIds.every((id) =>
                results.some(
                  (block) =>
                    block.tool_use_id === id &&
                    block.is_error === true &&
                    JSON.stringify(block.content).includes(denialReasons.get(id)),
                ),
              )
            ) {
              throw new Error(
                "Reviewer did not consume all three exact native denial IDs and reasons.",
              );
            }
            const ordinary = body.messages
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .filter(
                (block) =>
                  block.type === "tool_result" && block.tool_use_id === "toolu_worker_bash",
              );
            if (
              ordinary.length !== 1 ||
              ordinary[0].is_error ||
              !JSON.stringify(ordinary[0].content).includes(
                "NATIVE_CONTRACT_ORDINARY_TOOL_COMPLETE",
              )
            )
              throw new Error("Ordinary worker Bash did not complete unchanged.");
            ordinaryToolResults = ordinary.length;
            for (const block of results) providerDenials.set(block.tool_use_id, block);
            checkpoint("reviewer-consumed-denials", { count: results.length });
          }
          if (foregroundSchedule && turn > 1) {
            const completedIds = new Set(
              body.messages
                .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
                .filter(
                  (block) =>
                    block.type === "tool_result" &&
                    /^toolu_nested_[012]$/.test(block.tool_use_id) &&
                    !block.is_error &&
                    JSON.stringify(block.content).includes("Nested child complete."),
                )
                .map((block) => block.tool_use_id),
            );
            checkpoint("reviewer-consumed-foreground-results", { count: completedIds.size });
            if (completedIds.size !== 3)
              throw new Error(
                "Reviewer requested synthesis without three complete nested results.",
              );
          }
          const blocks =
            turn === 1
              ? [0, 1, 2].map((n) => {
                  const invocation = agent(
                    `toolu_nested_${n}`,
                    projectAgent?.name ?? "contract-leaf",
                    foregroundSchedule
                      ? `NATIVE_CONTRACT_LEAF_INPUT_${n}`
                      : "Complete the fixed nested task.",
                  );
                  if (effectiveBackground === undefined) delete invocation.input.run_in_background;
                  else invocation.input.run_in_background = effectiveBackground;
                  return invocation;
                })
              : text(
                  denialSchedule || foregroundSchedule || turn > 2
                    ? "Reviewer final synthesis."
                    : "Waiting for my nested children.",
                );
          if (denialSchedule && turn === 1)
            blocks.push({
              type: "tool_use",
              id: "toolu_worker_bash",
              name: "Bash",
              input: {
                command: "printf 'NATIVE_CONTRACT_ORDINARY_TOOL_COMPLETE\\n'",
                description: "Fixed ordinary worker tool",
              },
            });
          if (rootFanout && turn === 1) {
            reviewerResponse = { response, blocks };
            releaseRootFanout();
          } else sse(response, blocks);
        } else {
          const messages = JSON.stringify(body.messages);
          if (
            denialSchedule &&
            (messages.includes("NATIVE_CONTRACT_ORDINARY_TOOL_COMPLETE") ||
              messages.includes("toolu_worker_bash"))
          )
            throw new Error("Private worker tool content leaked to root provider.");
          if (turn > 1) rootLaunchConsumed = true;
          if (messages.includes("Waiting for my nested children.")) rootSawReviewer = true;
          // Only scripted marker/tool IDs survive request parsing.
          for (const id of ["toolu_nested_0", "toolu_nested_1", "toolu_nested_2"]) {
            if (messages.includes(`<tool-use-id>${id}</tool-use-id>`)) leafNotices.add(id);
          }
          allNestedSeen = leafNotices.size === 3;
          rootSawFinal ||= messages.includes("Reviewer final synthesis.");
          if (resumeReviewer && allNestedSeen && !resumeSent) {
            resumeSent = true;
            checkpoint("model-send-message");
            sse(response, [
              {
                type: "tool_use",
                id: "toolu_resume_reviewer",
                name: "SendMessage",
                input: {
                  to: "contract-reviewer-owner",
                  message: "All three nested tasks have completed. Produce the final synthesis.",
                },
              },
            ]);
          } else {
            const launch = agent(
              "toolu_reviewer",
              "contract-reviewer",
              "Delegate the three fixed nested tasks, then wait.",
            );
            launch.input.name = "contract-reviewer-owner";
            sse(
              response,
              turn === 1
                ? rootFanout
                  ? [
                      launch,
                      agent(
                        "toolu_root_peer",
                        "contract-root-peer",
                        "Complete the fixed peer task.",
                      ),
                    ]
                  : [launch]
                : text(
                    rootSawFinal
                      ? "Root final synthesis."
                      : "Waiting for the reviewer's final synthesis.",
                  ),
            );
          }
          releaseLeaves();
        }
      });
    } else if (route === "/v1/messages/count_tokens") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"input_tokens":16}');
    } else if (request.method === "HEAD" && route === "/api/hello") {
      response.writeHead(200);
      response.end();
    } else {
      unexpectedRequest = `${request.method} ${route}`;
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  let closeInput;
  const inputClosed = new Promise((resolve) => {
    closeInput = resolve;
  });
  const sessionId = randomUUID();
  const input = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: "Launch the fixed reviewer task." },
      };
      await inputClosed;
      inputEnded = true;
      checkpoint("input-closed");
      releaseLeaves();
    },
  };
  let child;
  let exited;
  let sdk;
  let timedOut = false;
  const kill = () => {
    if (!child) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    closeInput();
    sdk?.close();
    kill();
  }, 30_000);
  try {
    sdk = query({
      prompt: input,
      options: {
        cwd,
        sessionId,
        settingSources: projectAgent ? ["user", "project", "local"] : [],
        plugins: [],
        tools: projectAgent
          ? { type: "preset", preset: "claude_code" }
          : resumeReviewer
            ? ["Agent", "SendMessage"]
            : ["Agent"],
        ...(projectAgent
          ? {}
          : {
              agents: {
                "contract-reviewer": {
                  description: "Fixed reviewer",
                  prompt: "NATIVE_CONTRACT_REVIEWER_SYSTEM",
                  tools: ["Agent"],
                  model: "inherit",
                  background: true,
                },
                "contract-leaf": {
                  description: "Fixed leaf",
                  prompt: "NATIVE_CONTRACT_LEAF_SYSTEM",
                  tools: [],
                  model: "inherit",
                },
              },
            }),
        model: "claude-sonnet-5-5",
        effort: "low",
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
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
        hooks: {
          ...(hookNestedForeground || denialSchedule
            ? {
                PreToolUse: [
                  {
                    matcher: "Agent",
                    hooks: [
                      async (input, toolUseId, options) => {
                        const toolInput = input.tool_input;
                        if (denialSchedule) {
                          let output = {};
                          for (const callback of productionPreToolUse) {
                            const response = await callback(input, toolUseId, options);
                            if (response.hookSpecificOutput) output = response;
                          }
                          const decision =
                            output.hookSpecificOutput?.permissionDecision ?? "unchanged";
                          if (decision === "deny")
                            denialReasons.set(
                              input.tool_use_id,
                              output.hookSpecificOutput.permissionDecisionReason,
                            );
                          checkpoint("pre-tool-use-hook", {
                            agentId: input.agent_id ?? null,
                            toolName: input.tool_name,
                            toolUseId: input.tool_use_id,
                            background: toolInput.run_in_background ?? null,
                            decision,
                          });
                          return output;
                        }
                        const nested =
                          Boolean(input.agent_id) &&
                          input.tool_name === "Agent" &&
                          toolInput.run_in_background === true;
                        checkpoint("pre-tool-use-hook", {
                          agentId: input.agent_id ?? null,
                          toolName: input.tool_name,
                          toolUseId: input.tool_use_id,
                          background: toolInput.run_in_background,
                          decision: nested ? "foreground" : "unchanged",
                        });
                        return nested
                          ? {
                              hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: { ...toolInput, run_in_background: false },
                              },
                            }
                          : {};
                      },
                    ],
                  },
                ],
                PostToolUse: [
                  {
                    matcher: "Agent",
                    hooks: [
                      async (input) => {
                        const index = [0, 1, 2].find(
                          (n) => input.tool_use_id === `toolu_nested_${n}`,
                        );
                        checkpoint("post-tool-use-hook", {
                          agentId: input.agent_id ?? null,
                          toolName: input.tool_name,
                          toolUseId: input.tool_use_id,
                          index: index ?? null,
                          background: input.tool_input.run_in_background,
                        });
                        if (index === leafReleaseOrder[releasedForeground - 1])
                          releaseForegroundLeaf();
                        return {};
                      },
                    ],
                  },
                ],
              }
            : {}),
          SubagentStop: [
            {
              hooks: [
                async () => {
                  reviewerStopped = counts.reviewer >= 2;
                  checkpoint("subagent-stop-hook", { reviewerStopped });
                  releaseLeaves();
                  return {};
                },
              ],
            },
          ],
        },
        spawnClaudeCodeProcess: (options) => {
          checkpoint("native-spawn", {
            explicitPrintFlag: options.args.includes("--print") || options.args.includes("-p"),
            stdoutPiped: true,
            streamingInput:
              options.args.includes("--input-format") && options.args.includes("stream-json"),
          });
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
            child.once("close", () => {
              checkpoint("process-close");
              resolve();
            });
            child.once("error", reject);
          });
          child.stderr.resume();
          return child;
        },
      },
    });
    for await (const message of sdk) {
      if (message.type === "stream_event") continue;
      checkpoint("sdk-message", {
        messageType: message.type,
        subtype: message.subtype ?? null,
        parent: message.parent_tool_use_id ?? null,
        taskId: message.task_id ?? null,
        resultIndex: message.result_index ?? null,
        inventory:
          message.subtype === "background_tasks_changed"
            ? message.tasks.map((task) => ({
                taskId: task.task_id,
                taskType: task.task_type,
                ambient: task.ambient ?? false,
              }))
            : undefined,
      });
      if (
        message.type === "result" &&
        ((denialSchedule || foregroundSchedule
          ? rootSawFinal
          : allNestedSeen && (!resumeReviewer || rootSawFinal)) ||
          closePolicy === "first-result")
      ) {
        checkpoint("close-input-requested");
        closeInput();
        // Input EOF is the controlled counterfactual, not sdk.close() or interrupt.
      }
    }
    checkpoint("iterator-eof");
    await exited;
    if (timedOut)
      throw new Error(
        `Nested native contract exceeded its deadline: ${JSON.stringify({ counts, reviewerStopped, rootSawReviewer, heldLeaves: heldLeaves.length, leafNotices: leafNotices.size, events })}`,
      );
    if (unexpectedRequest) throw new Error(`Unexpected local request: ${unexpectedRequest}`);
    const paths = (await files(config)).filter((path) => path.endsWith(".jsonl"));
    let nestedCompletionsAtRoot = 0;
    let nestedCompletionsAtReviewer = 0;
    let rootAsyncAdmissions = 0;
    let nestedForegroundResults = 0;
    let rootSynthesisRecords = 0;
    let reviewerSynthesisRecords = 0;
    let nestedDenialResults = 0;
    let descendantNativeFiles = 0;
    for (const path of paths) {
      const fd = await open(path, "r");
      await fd.sync();
      await fd.close();
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const root = path.endsWith(`${sessionId}.jsonl`);
      if (
        !root &&
        !records.some(
          (record) =>
            record.type === "assistant" &&
            record.message?.content?.some(
              (block) =>
                (block.type === "tool_use" && /^toolu_nested_[012]$/.test(block.id)) ||
                (block.type === "text" && block.text === "Root peer complete."),
            ),
        )
      )
        ++descendantNativeFiles;
      for (const record of records) {
        if (record.type === "assistant") {
          const blocks = record.message?.content ?? [];
          if (
            root &&
            blocks.some((block) => block.type === "text" && block.text === "Root final synthesis.")
          )
            ++rootSynthesisRecords;
          if (
            !root &&
            blocks.some(
              (block) => block.type === "text" && block.text === "Reviewer final synthesis.",
            )
          )
            ++reviewerSynthesisRecords;
        }
        if (record.type !== "user") continue;
        const content = JSON.stringify(record.message?.content);
        const results = Array.isArray(record.message?.content)
          ? record.message.content.filter((block) => block.type === "tool_result")
          : [];
        if (
          root &&
          record.toolUseResult?.status === "async_launched" &&
          results.some(
            (block) =>
              block.tool_use_id === "toolu_reviewer" || block.tool_use_id === "toolu_root_peer",
          )
        )
          ++rootAsyncAdmissions;
        for (const block of results) {
          if (!/^toolu_nested_[012]$/.test(block.tool_use_id)) continue;
          const complete =
            !block.is_error && JSON.stringify(block.content).includes("Nested child complete.");
          checkpoint("native-nested-tool-result", {
            toolUseId: block.tool_use_id,
            root,
            complete,
            status: record.toolUseResult?.status ?? null,
          });
          if (!root && complete) ++nestedForegroundResults;
          if (!root && block.is_error === true && denialReasons.has(block.tool_use_id)) {
            if (!isDeepStrictEqual(block, providerDenials.get(block.tool_use_id)))
              throw new Error(
                "Native denial transcript differs from the exact provider tool result.",
              );
            ++nestedDenialResults;
          }
        }
        for (const id of ["toolu_nested_0", "toolu_nested_1", "toolu_nested_2"]) {
          if (!content.includes(`<tool-use-id>${id}</tool-use-id>`)) continue;
          if (root) ++nestedCompletionsAtRoot;
          else ++nestedCompletionsAtReviewer;
        }
      }
    }
    return {
      closePolicy,
      resumeReviewer,
      rootSawFinal,
      rootAsyncAdmissions,
      nestedForegroundResults,
      nestedDenialResults,
      descendantNativeFiles,
      peerRequests,
      ordinaryToolResults,
      rootSynthesisRecords,
      reviewerSynthesisRecords,
      counts,
      reviewerResumed: counts.reviewer > 2,
      nestedCompletionsAtRoot,
      nestedCompletionsAtReviewer,
      events,
    };
  } finally {
    clearTimeout(timer);
    closeInput();
    sdk?.close();
    if (child && child.exitCode === null && child.signalCode === null) kill();
    if (exited) await exited.catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}
