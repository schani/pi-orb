import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { createDurableModels } from "./models.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The qualification fake sends these Responses events, including message items without role/phase.
function responseEvents(planText: boolean) {
  const plan = planText
    ? {
        type: "message",
        id: "plan",
        content: [{ type: "output_text", text: "I will run the check." }],
      }
    : {
        type: "reasoning",
        id: "plan",
        summary: [{ text: "I will run the check." }],
        encrypted_content: "enc",
      };
  const call = {
    type: "function_call",
    id: "fc",
    call_id: "call",
    name: "bash",
    arguments: '{"command":"echo E2E_TOOL_OK"}',
  };
  return [
    { type: "response.created", response: { id: "first" } },
    { type: "response.output_item.added", output_index: 0, item: { type: plan.type, id: plan.id } },
    {
      type: planText ? "response.output_text.delta" : "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "I will run the check.",
    },
    { type: "response.output_item.done", output_index: 0, item: plan },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...call, arguments: undefined },
    },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: call.arguments },
    { type: "response.function_call_arguments.done", output_index: 1, arguments: call.arguments },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: {
        id: "first",
        status: "completed",
        usage: { input_tokens: 120, output_tokens: 25 },
      },
    },
  ];
}

describe("native HTTP tool-round completion", () => {
  it.each([false, true])(
    "publishes final history before one completion and one summary (plan text=%s)",
    async (planText) => {
      const toolEntered = barrier();
      const toolRelease = barrier();
      const finalEntered = barrier();
      const finalRelease = barrier();
      const summaryEntered = barrier();
      const notificationEntered = barrier();
      const requests: unknown[] = [];
      const summaries: string[] = [];
      const frames: ServerFrame[] = [];
      const final = "The check succeeded: E2E_TOOL_OK.";
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
          requests.push(
            JSON.parse(
              (request.headers["content-encoding"] === "zstd"
                ? zstdDecompressSync(bytes)
                : bytes
              ).toString(),
            ),
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
          if (requests.length === 1) {
            for (const event of responseEvents(planText)) send(event);
            response.end();
          } else {
            send({ type: "response.created", response: { id: "final" } });
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "msg" },
            });
            send({ type: "response.output_text.delta", output_index: 0, delta: final });
            finalEntered.resolve();
            void finalRelease.promise.then(() => {
              send({
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg",
                  content: [{ type: "output_text", text: final }],
                },
              });
              send({
                type: "response.completed",
                response: {
                  id: "final",
                  status: "completed",
                  usage: { input_tokens: 180, output_tokens: 12 },
                },
              });
              response.end();
            });
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const claims = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
      ).toString("base64url");
      const models = (
        await createDurableModels({
          token: () =>
            okAsync({ accessToken: `header.${claims}.signature`, expiresAt: Date.now() + 3600000 }),
          inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
        })
      )._unsafeUnwrap();
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "tool-barrier",
          tools: [
            defineTool({
              name: "bash",
              description: "controlled shell",
              parameters: Type.Object({ command: Type.String() }),
              replay: "safe",
              execute: async () => {
                toolEntered.resolve();
                await toolRelease.promise;
                return { content: [{ type: "text", text: "E2E_TOOL_OK\n" }] };
              },
            }),
          ],
        }),
      );
      const agent = (
        await DurableAgent.open({
          orbId: "orb",
          storage: new MemoryStorage(),
          models,
          registry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "instruction",
          initialSettings: {
            model: { provider: "openai-codex", id: "gpt-6-astra" },
            thinkingLevel: "off",
          },
          turnSummary: {
            task: new NoSimulationTask("tool-summary", false),
            summarizer: {
              summarize: (input) => {
                summaries.push(input.transcript);
                summaryEntered.resolve();
                return okAsync("Check completed.");
              },
            },
          },
        })
      )._unsafeUnwrap();
      agent.subscribe((frame) => {
        frames.push(frame);
        if (frame.type === "runtime.event" && frame.event.type === "turn_notification")
          notificationEntered.resolve();
      });
      const completed = () =>
        frames.filter(
          (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
        );
      try {
        (
          await agent.deliver({
            baseUrl: "unused",
            messageId: "input",
            messageIds: ["input"],
            content: [{ type: "text", text: "please run the e2e tool check" }],
          })
        )._unsafeUnwrap();
        await toolEntered.promise;
        await setImmediate();
        expect(completed()).toHaveLength(0);
        expect(summaries).toHaveLength(0);
        expect(agent.snapshot()._unsafeUnwrap().activity).toBe("busy");
        toolRelease.resolve();
        await finalEntered.promise;
        await setImmediate();
        expect(completed()).toHaveLength(0);
        expect(summaries).toHaveLength(0);
        expect(agent.snapshot()._unsafeUnwrap().activity).toBe("busy");
        finalRelease.resolve();
        (await agent.waitForIdle())._unsafeUnwrap();
        await summaryEntered.promise;
        await notificationEntered.promise;
        expect(
          frames.filter(
            (frame) => frame.type === "runtime.event" && frame.event.type === "turn_notification",
          ),
        ).toHaveLength(1);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain("function_call_output");
        expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).toContain(final);
        expect(completed()).toHaveLength(1);
        expect(completed()[0]).toMatchObject({ event: { outcome: "completed" } });
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain(final);
        const historyIndex = frames.findIndex(
          (frame) =>
            frame.type === "history.record" && JSON.stringify(frame.record).includes(final),
        );
        expect(historyIndex).toBeGreaterThanOrEqual(0);
        expect(frames.indexOf(completed()[0]!)).toBeGreaterThan(historyIndex);
      } finally {
        toolRelease.resolve();
        finalRelease.resolve();
        await agent.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
