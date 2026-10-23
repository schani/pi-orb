import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { ModelCall } from "../../domain/model-usage.ts";
import { modelCall } from "../model-usage.ts";
import { PostgreSQLModelUsageLedger } from "../pg/model-usage.ts";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { meterModels } from "./model-usage.ts";
import { createDurableModels } from "./models.ts";
import { createDurableTools } from "./tools/index.ts";

const usage = (total = 10) => ({
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: total,
  input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
});
function completed(id: string, items: unknown[], total?: number) {
  return [
    { type: "response.created", response: { id } },
    ...items.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: { id, status: "completed", usage: usage(total) },
    },
  ];
}
const text = (id: string, value: string, total?: number) =>
  completed(id, [{ type: "message", id, content: [{ type: "output_text", text: value }] }], total);
const call = (id: string, code: string) =>
  completed(id, [
    {
      type: "custom_tool_call",
      id: `ctc_${id}`,
      call_id: `call_${id}`,
      name: "codemode",
      input: code,
    },
  ]);

// Contract with pi-durable 1.4.0 internals the ledger classification relies on (docs/model-usage.md).
describe("durable model usage capture", () => {
  it("classifies root, subagent and compaction calls and records the provider's usage", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(426);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const raw = (
          request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes
        ).toString();
        const body = JSON.parse(raw) as {
          instructions?: string;
          input?: Array<{
            type?: string;
            role?: string;
            content?: Array<{ type: string; text?: string }>;
          }>;
        };
        const userText = body.input
          ?.filter((item) => item.role === "user")
          .flatMap((item) => item.content ?? [])
          .filter((part) => part.type === "input_text")
          .map((part) => part.text ?? "");
        const owner = body.instructions?.includes("context summarization assistant")
          ? "compaction"
          : userText?.includes("CHILD_TASK")
            ? "child"
            : "root";
        requests.push(owner);
        const outputs =
          body.input?.filter((item) => item.type === "custom_tool_call_output").length ?? 0;
        const events =
          owner === "compaction"
            ? text("summary", "Turn one spawned a child.")
            : owner === "child"
              ? text("child", "child done")
              : userText?.some((value) => value.startsWith("ROOT_TURN_THREE"))
                ? text("third", "third done")
                : userText?.some((value) => value.startsWith("ROOT_TURN_TWO"))
                  ? // A full context window makes the next generation compact first.
                    text("second", "second done", 10_000_000)
                  : outputs === 0
                    ? call(
                        "spawn",
                        'const child = JSON.parse(await tools.subagent({prompt:"CHILD_TASK"})); store("child", child.agent_id); text(child);',
                      )
                    : outputs === 1
                      ? call(
                          "wait",
                          'text(JSON.parse(await tools.get_subagent_result({agent_id:load("child"),wait:true})).receipt);',
                        )
                      : text("first", "first done");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
    ).toString("base64url");
    const recorded: ModelCall[] = [];
    let allRecorded!: () => void;
    const seven = new Promise<void>((resolve) => {
      allRecorded = resolve;
    });
    const models = (
      await createDurableModels({
        token: () =>
          okAsync({ accessToken: `header.${claims}.signature`, expiresAt: Date.now() + 3600000 }),
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      })
    )._unsafeUnwrap();
    const registry = createRegistry();
    const tools = createDurableTools();
    registry.install(tools.extension);
    registry.install(tools.childExtension);
    const { storage } = (await new MemoryAgentPersistence().openOrb("orb", false))._unsafeUnwrap();
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry,
        modelTools: tools.modelTools,
        childExtension: tools.childExtension,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings: {
          model: { provider: "openai-codex", id: "gpt-6-astra" },
          thinkingLevel: "off",
        },
        recordModelCall: (use, response) => {
          recorded.push(modelCall({ ownerUserId: "owner", orbId: "orb", use }, response));
          if (recorded.length === 7) allRecorded();
        },
      })
    )._unsafeUnwrap();
    const turn = async (id: string, padding = "") => {
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: id,
          messageIds: [id],
          content: [{ type: "text", text: `${id}${padding}` }],
        })
      )._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
    };
    try {
      await turn("ROOT_TURN_ONE");
      // Enough recent context that compaction can keep turn two and summarize turn one.
      await turn("ROOT_TURN_TWO", ` ${"word ".repeat(30_000)}`);
      await turn("ROOT_TURN_THREE");
      await seven;
    } finally {
      await agent.close();
      await tools.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The child runs concurrently with the root's wait call; only turn order is fixed.
    expect(requests.slice(4)).toEqual(["root", "compaction", "root"]);
    expect(requests.slice(0, 4).sort()).toEqual(["child", "root", "root", "root"]);
    expect(recorded.map(({ use }) => use).sort()).toEqual([
      "compaction",
      "root",
      "root",
      "root",
      "root",
      "root",
      "subagent",
    ]);
    for (const { use: _, ...call } of recorded)
      expect(call).toEqual({
        ownerUserId: "owner",
        orbId: "orb",
        provider: "openai-codex",
        model: "gpt-6-astra",
        outcome: expect.stringMatching(/^(stop|toolUse)$/),
        input: 5,
        output: 2,
        cacheRead: 4,
        cacheWrite: 1,
        costUsd: expect.any(Number),
        durationMs: expect.any(Number),
      });
  });

  it("returns responses while the ledger write never settles", async () => {
    const task = new NoSimulationTask("stalled ledger", false);
    let started = 0;
    const ledger = new PostgreSQLModelUsageLedger({
      query: () => new ResultAsync(new Promise(() => undefined)),
      transaction: () => {
        started++;
        return new ResultAsync(new Promise(() => undefined));
      },
      end: () => okAsync(undefined),
    });
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-6-astra",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stub = {
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      },
      completeSimple: () => Promise.resolve(message),
    } as unknown as Models;
    const metered = meterModels(
      stub,
      () => "root-session",
      (use, response) =>
        ledger.record(task, modelCall({ ownerUserId: "owner", orbId: "orb", use }, response)),
    );
    const model = {} as Parameters<Models["streamSimple"]>[0];
    const events: string[] = [];
    const stream = metered.streamSimple(model, { messages: [] }, { sessionId: "root-session" });
    for await (const event of stream) events.push(event.type);
    expect(events).toEqual(["done"]);
    expect((await stream.result()).stopReason).toBe("stop");
    expect((await metered.completeSimple(model, { messages: [] }, {})).stopReason).toBe("stop");
    await Promise.resolve();
    expect(started).toBe(2);
  });
});
