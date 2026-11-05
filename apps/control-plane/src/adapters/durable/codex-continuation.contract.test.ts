import { type Message, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sessionId = "offline-continuation";
const claims = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } }),
).toString("base64");
const apiKey = `fake.${claims}.signature`;
const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
if (!model) throw new Error("missing pinned Codex model");

function completed(id: string) {
  const item = {
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    content: [{ type: "output_text", text: "offline reply" }],
  };
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed" } },
  ];
}

type Request = { input: unknown[]; previous_response_id?: string; store?: boolean };
function mockTransport(failure?: "connect" | "after-start" | "missing-continuation") {
  const requests: Request[] = [];
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event(failure === "connect" ? "error" : "open"));
      });
    }
    send(raw: string) {
      requests.push(JSON.parse(raw) as Request);
      const events =
        failure === "missing-continuation" && requests.length === 2
          ? [{ type: "error", code: "previous_response_not_found", message: "missing" }]
          : failure === "after-start"
            ? [{ type: "response.created", response: { id: "resp_partial" } }]
            : completed(`resp_${requests.length}`);
      // Dispatch after send returns: the parser attaches listeners synchronously.
      queueMicrotask(() => {
        for (const event of events)
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
      });
    }
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const fetch = vi.fn(
    async () =>
      new Response(
        completed("resp_sse")
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return { requests, sockets, fetch };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
});
afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketDebugStats();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function twoTurns(transport?: SimpleStreamOptions["transport"]) {
  const messages: Message[] = [{ role: "user", content: "first", timestamp: 0 }];
  const options = { apiKey, sessionId, env: {}, ...(transport === undefined ? {} : { transport }) };
  const first = await streamSimple(model, normalizeContext({ messages }), options).result();
  expect(first.stopReason).toBe("stop");
  messages.push(first, { role: "user", content: "second", timestamp: 0 });
  const second = await streamSimple(model, normalizeContext({ messages }), options).result();
  expect(second.stopReason).toBe("stop");
}

it.each([
  [undefined, false],
  ["websocket", false],
  ["auto", true],
  ["websocket-cached", true],
] as const)("uses native context caching for transport %s", async (transport, cached) => {
  const mock = mockTransport();
  await twoTurns(transport);
  expect(mock.sockets).toHaveLength(1);
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(mock.requests.map((request) => request.input.length)).toEqual([1, cached ? 1 : 3]);
  expect(mock.requests[1]?.previous_response_id).toBe(cached ? "resp_1" : undefined);
  expect(mock.requests.every((request) => request.store === false)).toBe(true);
  expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
    connectionsCreated: 1,
    connectionsReused: 1,
    cachedContextRequests: cached ? 2 : 0,
    fullContextRequests: cached ? 1 : 2,
    deltaRequests: cached ? 1 : 0,
  });
});

it.each(["auto", "websocket-cached"] as const)(
  "retries missing continuation with full context for %s",
  async (transport) => {
    const mock = mockTransport("missing-continuation");
    await twoTurns(transport);
    expect(mock.requests.map((request) => request.input.length)).toEqual([1, 1, 3]);
    expect(mock.requests[1]?.previous_response_id).toBe("resp_1");
    expect(mock.requests[2]?.previous_response_id).toBeUndefined();
    expect(mock.sockets).toHaveLength(2);
    expect(mock.fetch).not.toHaveBeenCalled();
  },
);

it.each([undefined, "auto"] as const)(
  "does not replay over SSE after output starts for %s",
  async (transport) => {
    const mock = mockTransport("after-start");
    const result = await streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey,
      sessionId,
      env: {},
      ...(transport === undefined ? {} : { transport }),
      onProviderStreamEvent: () => {
        mock.sockets[0]?.dispatchEvent(new Event("error"));
      },
    }).result();
    expect(result.stopReason).toBe("error");
    expect(mock.fetch).not.toHaveBeenCalled();
  },
);
