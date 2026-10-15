import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import {
  type ClaudeModelCall,
  startModelUsageReceiver,
  telemetryEnvironment,
} from "./model-usage.ts";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

/** Fake Messages API: the first request offering `Agent` spawns a subagent; every response bills distinct input. */
function fakeAnthropic() {
  let requests = 0;
  let spawned = false;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const path = request.url?.split("?")[0];
      if (request.method === "POST" && path === "/v1/messages") {
        const body = JSON.parse(text) as { tools?: { name: string }[] };
        const spawn = !spawned && (body.tools ?? []).some((tool) => tool.name === "Agent");
        spawned ||= spawn;
        ++requests;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "request-id": `req_contract_${requests}`,
        });
        const emit = (type: string, data: object) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        emit("message_start", {
          message: {
            id: `msg_contract_${requests}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 100 + requests,
              output_tokens: 0,
              cache_read_input_tokens: 1000,
              cache_creation_input_tokens: 50,
            },
          },
        });
        if (spawn) {
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
                subagent_type: "helper",
                prompt: "Say ok.",
                description: "Contract helper",
              }),
            },
          });
        } else {
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
        }
        emit("content_block_stop", { index: 0 });
        emit("message_delta", {
          delta: { stop_reason: spawn ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 7 },
        });
        emit("message_stop", {});
        response.end();
      } else if (path === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":16}');
      } else {
        response.writeHead(path === "/api/hello" ? 200 : 404);
        response.end();
      }
    });
  });
  return { server, requests: () => requests };
}

nativeIt(
  "real Claude Code exports every root, subagent and compaction call to the receiver",
  async () => {
    const calls: ClaudeModelCall[] = [];
    let compacted: () => void = () => undefined;
    const compactExported = new Promise<void>((resolve) => {
      compacted = resolve;
    });
    const receiver = (
      await startModelUsageReceiver((call) => {
        calls.push(call);
        if (call.querySource === "compact") compacted();
      })
    )._unsafeUnwrap();
    const fake = fakeAnthropic();
    const api = fake.server;
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const home = await mkdtemp(join(tmpdir(), "claude-model-usage-"));
    try {
      await mkdir(join(home, "workspace"));
      await mkdir(join(home, "config"));
      let next: () => void = () => undefined;
      let done: () => void = () => undefined;
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: "Spawn the helper." },
        };
        await new Promise<void>((resolve) => {
          next = resolve;
        });
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: "/compact" },
        };
        await new Promise<void>((resolve) => {
          done = resolve;
        });
      }
      const session = query({
        prompt: input(),
        options: {
          cwd: join(home, "workspace"),
          env: {
            HOME: home,
            PATH: process.env.PATH,
            TMPDIR: home,
            CLAUDE_CONFIG_DIR: join(home, "config"),
            ANTHROPIC_API_KEY: "dummy-model-usage-contract-not-a-real-key",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            ...telemetryEnvironment(receiver),
          },
          model: "claude-sonnet-5-5",
          agents: { helper: { description: "Contract helper", prompt: "Answer briefly." } },
          settingSources: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });
      let results = 0;
      for await (const message of session) {
        if (message.type !== "result") continue;
        if (++results === 1) next();
        else break;
      }
      await compactExported;
      done();
      session.close();

      const ok = calls.filter((call) => call.outcome === "ok");
      expect(ok.length).toBe(calls.length);
      expect(new Set(ok.map((call) => call.querySource))).toEqual(
        new Set(["generate_session_title", "sdk", "agent:custom", "compact"]),
      );
      for (const call of ok) {
        expect(call).toMatchObject({
          model: "claude-sonnet-5-5",
          cacheRead: 1000,
          cacheWrite: 50,
          output: 7,
          requestId: expect.stringMatching(/^req_contract_\d+$/),
        });
        expect(call.costUsd).toBeGreaterThan(0);
      }
      // Each fake response bills distinct input, so input identifies every API request exactly once.
      expect(ok.map((call) => call.input).sort()).toEqual(
        Array.from({ length: fake.requests() }, (_, index) => 101 + index),
      );
    } finally {
      await receiver.close();
      api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
