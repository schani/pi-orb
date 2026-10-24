import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
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
const reasoned = (id: string, value: string) =>
  completed(id, [
    { type: "reasoning", id: `rs_${id}`, summary: [{ type: "summary_text", text: "Think." }] },
    { type: "message", id, content: [{ type: "output_text", text: value }] },
  ]);
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
                ? reasoned("third", "third done")
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
                      : reasoned("first", "first done");
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
        recordModelCall: (use, response, timing) => {
          recorded.push(modelCall({ ownerUserId: "owner", orbId: "orb", use }, response, timing));
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
    for (const { use, responseId, ttftMs, thinkingMs, ...call } of recorded) {
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
      // completeSimple does not stream; every streamed response had content.
      if (use === "compaction") {
        expect([responseId, ttftMs, thinkingMs]).toEqual(["summary", undefined, undefined]);
        continue;
      }
      const ttft = ttftMs ?? -1;
      const answered = thinkingMs ?? ttft;
      expect(ttft).toBeGreaterThanOrEqual(0);
      expect(answered).toBeGreaterThanOrEqual(ttft);
      expect(answered).toBeLessThanOrEqual(call.durationMs ?? -1);
      expect(thinkingMs !== undefined).toBe(responseId === "first" || responseId === "third");
    }
    // Ledger rows join exactly to the public history's native assistant messages.
    const history = agent
      .snapshot()
      ._unsafeUnwrap()
      .records.flatMap((record) => {
        const native = record.overflow["native"] as { message?: { responseId?: string } };
        return native?.message?.responseId === undefined ? [] : [native.message.responseId];
      });
    expect(
      recorded
        .filter(({ use }) => use === "root")
        .map(({ responseId }) => responseId)
        .sort(),
    ).toEqual([...history].sort());
    expect(history.sort()).toEqual(["first", "second", "spawn", "third", "wait"]);
  });

  it("times the first content and the first answer back from the response's end", async () => {
    let clock = 0;
    const message = (durationMs?: number): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-6-astra",
      responseId: "resp",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    let script: ReadonlyArray<readonly [number, AssistantMessageEvent["type"]]> = [];
    let durationMs: number | undefined;
    const stub = {
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        const partial = message();
        queueMicrotask(() => {
          for (const [at, type] of script) {
            clock = at;
            stream.push(
              type === "done"
                ? { type, reason: "stop", message: message(durationMs) }
                : type === "start"
                  ? { type, partial }
                  : ({ type, contentIndex: 0, partial } as AssistantMessageEvent),
            );
          }
        });
        return stream;
      },
      completeSimple: () => Promise.resolve(message(7)),
    } as unknown as Models;
    const recorded: ModelCall[] = [];
    const metered = meterModels(
      stub,
      () => "root",
      () => clock,
      (use, response, timing) =>
        recorded.push(modelCall({ ownerUserId: "owner", orbId: "orb", use }, response, timing)),
    );
    const model = {} as Parameters<Models["streamSimple"]>[0];
    const run = async (events: typeof script, duration?: number) => {
      script = events;
      durationMs = duration;
      await metered.streamSimple(model, { messages: [] }, { sessionId: "root" }).result();
      await Promise.resolve();
      return recorded.at(-1);
    };
    // Reasoning first: thinking runs to the first text; the stream started 50 ms before `start`.
    expect(
      await run(
        [
          [100, "start"],
          [130, "thinking_start"],
          [150, "thinking_delta"],
          [180, "text_start"],
          [190, "toolcall_start"],
          [200, "done"],
        ],
        150,
      ),
    ).toMatchObject({ responseId: "resp", durationMs: 150, ttftMs: 80, thinkingMs: 130 });
    // No reasoning: no thinking time.
    const plain = await run(
      [
        [100, "start"],
        [140, "toolcall_start"],
        [200, "done"],
      ],
      150,
    );
    expect(plain).toMatchObject({ ttftMs: 90 });
    expect(plain).not.toHaveProperty("thinkingMs");
    // A clock that disagrees with the response's own duration is clamped into it.
    expect(
      await run(
        [
          [0, "thinking_start"],
          [500, "text_start"],
          [400, "done"],
        ],
        150,
      ),
    ).toMatchObject({ ttftMs: 0, thinkingMs: 150 });
    // Without a measured duration, or without content, nothing is anchored.
    for (const [events, duration] of [
      [
        [
          [100, "text_start"],
          [200, "done"],
        ],
        undefined,
      ],
      [
        [
          [100, "start"],
          [200, "done"],
        ],
        150,
      ],
    ] as const) {
      const untimed = await run(events, duration);
      expect(untimed).not.toHaveProperty("ttftMs");
      expect(untimed).not.toHaveProperty("thinkingMs");
    }
    await metered.completeSimple(model, { messages: [] }, {});
    await Promise.resolve();
    expect(recorded.at(-1)).toMatchObject({ use: "compaction", responseId: "resp", durationMs: 7 });
    expect(recorded.at(-1)).not.toHaveProperty("ttftMs");
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
      () => 0,
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
