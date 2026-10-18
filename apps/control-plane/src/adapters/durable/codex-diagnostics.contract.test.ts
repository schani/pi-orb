import { createServer } from "node:http";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  stream,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { okAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createDurableModels } from "./models.ts";

const claims = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
).toString("base64url");
const apiKey = `header.${claims}.signature`;
const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
if (!model) throw new Error("missing pinned Codex model");
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
const transcript = normalizeContext(context);
const unauthorized = () =>
  new Response(
    JSON.stringify({ error: { message: "original unauthorized", code: "invalid_api_key" } }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
});

it.each(["missing_api_key", "invalid_jwt", "payload_rejected", "invalid_header"])(
  "does not fabricate transport diagnostics for preflight failure: %s",
  async (failure) => {
    const fetch = vi.fn(() => Promise.reject(new Error("network must not be called")));
    const result = await stream(model, transcript, {
      env: {},
      ...(failure === "missing_api_key"
        ? {}
        : { apiKey: failure === "invalid_jwt" ? "not-a-jwt" : apiKey }),
      fetch,
      ...(failure === "payload_rejected"
        ? { onPayload: () => Promise.reject(new Error("preflight rejected")) }
        : {}),
      ...(failure === "invalid_header" ? { headers: { "bad\nheader": "value" } } : {}),
      codexBrokerDiagnostics: { brokerGeneration: 3, tokenExpiresAt: Date.now() + 3600000 },
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.diagnostics?.filter((item) => item.type === "codex_failure") ?? []).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("finishes the original fetch failure despite a throwing diagnostic code getter", async () => {
  const error = new Error("original fetch failure");
  Object.defineProperty(error, "code", {
    get: () => {
      throw new Error("diagnostic getter secret");
    },
  });
  const fetch = vi.fn(() => Promise.reject(error));
  const result = await stream(model, transcript, {
    apiKey,
    transport: "sse",
    maxRetries: 0,
    fetch,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("original fetch failure");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      type: "codex_failure",
      transport: "sse",
      attempt: 1,
    }),
  );
  expect(JSON.stringify(result)).not.toContain("diagnostic getter secret");
  expect(fetch).toHaveBeenCalledOnce();
});

it("finishes the original HTTP failure despite throwing request-ID lookup", async () => {
  const response = unauthorized();
  const get = response.headers.get.bind(response.headers);
  Object.defineProperty(response.headers, "get", {
    value: (name: string) => {
      if (name === "x-request-id") throw new Error("diagnostic header secret");
      return get(name);
    },
  });
  const fetch = vi.fn(async () => response);
  const result = await stream(model, transcript, {
    apiKey,
    transport: "sse",
    maxRetries: 0,
    fetch,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("original unauthorized");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      type: "codex_failure",
      status: 401,
      code: "invalid_api_key",
    }),
  );
  expect(JSON.stringify(result)).not.toContain("diagnostic header secret");
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not let a throwing ModelRuntime diagnostic callback block inference or leak secrets", async () => {
  const runtime = (
    await createDurableModels({
      token: () => okAsync({ accessToken: apiKey, expiresAt: Date.now() + 3600000 }),
    })
  )._unsafeUnwrap();
  runtime.registerProvider("openai-codex", {
    getRequestDiagnostics: () => {
      throw new Error("diagnostic callback secret");
    },
  });
  const fetch = vi.fn(async () => unauthorized());
  const result = await runtime.complete(model, context, { apiKey, transport: "sse", fetch });
  expect(result.stopReason).toBe("error");
  expect(result.diagnostics, JSON.stringify(result)).toContainEqual(
    expect.objectContaining({ type: "codex_failure", status: 401 }),
  );
  expect(JSON.stringify(result)).not.toContain("diagnostic callback secret");
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not attribute a previous HTTP response to a later transport failure", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_12345678",
          "retry-after-ms": "0",
        },
      }),
    )
    .mockRejectedValueOnce(new Error("connection lost"));
  const result = await stream(model, transcript, {
    apiKey,
    transport: "sse",
    maxRetries: 1,
    fetch,
  }).result();
  expect(result.stopReason).toBe("error");
  const final = result.diagnostics?.findLast((item) => item.type === "codex_failure");
  expect(final).toMatchObject({
    transport: "sse",
    attempt: 2,
    phase: "before_message_stream_start",
  });
  for (const key of ["status", "code", "requestId"]) expect(final).not.toHaveProperty(key);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("binds broker metadata to the actual bearer when failures finish out of order", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000000);
  const expiry = Date.now() + 3600000;
  const token = vi
    .fn()
    .mockImplementationOnce(() =>
      okAsync({ accessToken: apiKey, generation: 1, expiresAt: expiry }),
    )
    .mockImplementationOnce(() =>
      okAsync({ accessToken: `${apiKey}2`, generation: 2, expiresAt: expiry + 3600000 }),
    );
  const runtime = (await createDurableModels({ token }))._unsafeUnwrap();
  let arrived = () => {};
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release = (_response: Response) => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => {
      arrived();
      return pending;
    })
    .mockImplementationOnce(async () => unauthorized());
  const first = runtime.complete(model, context, { transport: "sse", maxRetries: 0, fetch });
  try {
    await entered;
    now.mockReturnValue(expiry - 1000);
    const second = await runtime.complete(model, context, {
      transport: "sse",
      maxRetries: 0,
      fetch,
    });
    release(unauthorized());
    const original = await first;
    expect(original.stopReason).toBe("error");
    expect(second.stopReason).toBe("error");
    expect(original.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "codex_failure",
        brokerGeneration: 1,
        tokenExpiresAt: expiry,
      }),
    );
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "codex_failure",
        brokerGeneration: 2,
        tokenExpiresAt: expiry + 3600000,
      }),
    );
    const bearers = fetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("authorization"),
    );
    expect(bearers).toEqual([`Bearer ${apiKey}`, `Bearer ${apiKey}2`]);
    expect(JSON.stringify([original.diagnostics, second.diagnostics])).not.toContain(apiKey);
    expect(token).toHaveBeenCalledTimes(2);
  } finally {
    release(unauthorized());
    await first;
  }
});

async function websocketRuntime(fallback: boolean) {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
  });
  const sockets = new WebSocketServer({ server });
  let requests = 0;
  sockets.on("connection", (socket) => {
    const request = ++requests;
    socket.once("message", () => {
      if (fallback || request === 1) {
        if (!fallback)
          socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
        socket.close(1011, "raw-secret-reason");
      } else {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "invalid_api_key",
            message: "raw-secret-provider-text",
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  const token = vi.fn(() =>
    okAsync({ accessToken: apiKey, generation: 4, expiresAt: Date.now() + 3600000 }),
  );
  const runtime = (
    await createDurableModels({ token, inferenceBaseUrl: `http://127.0.0.1:${address.port}` })
  )._unsafeUnwrap();
  const runtimeModel = runtime.getModels("openai-codex").find((item) => item.id === model.id);
  if (!runtimeModel) throw new Error("missing runtime Codex model");
  return {
    runtime,
    token,
    model: runtimeModel,
    requests: () => requests,
    close: async () => {
      closeOpenAICodexWebSocketSessions();
      for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    },
  };
}

it("sanitizes WS close diagnostics and keeps a later structured auth failure separate", async () => {
  const fixture = await websocketRuntime(false);
  try {
    const first = await fixture.runtime.complete(fixture.model, context, {
      transport: "websocket",
    });
    const second = await fixture.runtime.complete(fixture.model, context, {
      transport: "websocket",
    });
    expect(first.stopReason).toBe("error");
    expect(second.stopReason).toBe("error");
    expect(first.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "codex_failure",
        transport: "websocket",
        phase: "after_message_stream_start",
        wsCloseCode: 1011,
      }),
    );
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "codex_failure",
        transport: "websocket",
        code: "invalid_api_key",
      }),
    );
    expect(JSON.stringify([first.diagnostics, second.diagnostics])).not.toContain("raw-secret");
    expect(first.content.filter((item) => item.type === "toolCall")).toEqual([]);
    expect(second.content.filter((item) => item.type === "toolCall")).toEqual([]);
    expect(fixture.requests()).toBe(2);
    expect(fixture.token).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});

it("keeps pre-start WS fallback distinct from the final SSE failure", async () => {
  const fixture = await websocketRuntime(true);
  try {
    const result = await fixture.runtime.complete(fixture.model, context, { transport: "auto" });
    expect(result.stopReason).toBe("error");
    expect(result.diagnostics?.filter((item) => item.type === "codex_failure")).toEqual([
      expect.objectContaining({
        transport: "websocket",
        phase: "before_message_stream_start",
        wsCloseCode: 1011,
      }),
      expect.objectContaining({
        transport: "sse",
        status: 401,
        code: "invalid_api_key",
        brokerGeneration: 4,
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("raw-secret");
    expect(fixture.requests()).toBe(1);
    expect(fixture.token).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});
