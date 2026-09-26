import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { BrokerEndpoint } from "../domain/broker-client.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { mapPiEntry } from "../pi/mapping.ts";
import { brokerProviderConfig } from "./provider.ts";

const token = (() => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "retry-contract" } })}.sig`;
})();

it("AgentSession retries a started WS 1011 once, retains failures, and never replays an executed tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-retry-contract-"));
  const server = createServer((_request, response) => {
    httpRequests++;
    response.writeHead(401, { "content-type": "application/json", "x-request-id": "req_12345678" });
    response.end(
      JSON.stringify({ error: { code: "invalid_api_key", message: "SECRET_PROVIDER_TEXT" } }),
    );
  });
  const sockets = new WebSocketServer({ server });
  let httpRequests = 0;
  let wsRequests = 0;
  let toolRuns = 0;
  const retryEvents: string[] = [];
  const response = (socket: import("ws").WebSocket, event: unknown) =>
    socket.send(JSON.stringify(event));
  sockets.on("connection", (socket) => {
    socket.on("message", () => {
      wsRequests++;
      response(socket, { type: "response.created", response: { id: `resp_${wsRequests}` } });
      if (wsRequests === 1) {
        const call = {
          type: "function_call",
          id: "fc_once",
          call_id: "call_once",
          name: "once",
          arguments: "{}",
        };
        response(socket, { type: "response.output_item.added", output_index: 0, item: call });
        response(socket, { type: "response.output_item.done", output_index: 0, item: call });
        response(socket, {
          type: "response.completed",
          response: { id: "resp_1", status: "completed", output: [call] },
        });
      } else {
        response(socket, {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_partial", content: [] },
        });
        socket.close(1011, "SECRET_WS_REASON");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const task = new NoSimulationTask("session-retry-contract", false);
    const endpoint: BrokerEndpoint = {
      requestToken: async () => ({
        kind: "grant",
        grant: {
          accessToken: token,
          accountId: "retry-contract",
          expiresAt: Date.now() + 3_600_000,
          generation: 1,
        },
      }),
    };
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    runtime.registerProvider(
      "openai-codex",
      brokerProviderConfig(task, new BrokerTokenClient(endpoint), {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      }),
    );
    await runtime.login("openai-codex", "oauth", {
      prompt: () => Promise.reject(new Error("unexpected prompt")),
      notify: () => {},
    });
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModels("openai-codex")[0];
    if (!model) throw new Error("no Codex model");
    const manager = SessionManager.inMemory(dir);
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, baseDelayMs: 0, maxRetries: 1 },
      }),
      model,
      tools: ["once"],
      customTools: [
        {
          name: "once",
          label: "Once",
          description: "Count one execution",
          parameters: Type.Object({}),
          execute: async () => {
            toolRuns++;
            return { content: [{ type: "text" as const, text: "done" }], details: undefined };
          },
        },
      ],
    }));
    session.subscribe((event) => {
      if (event.type === "auto_retry_start" || event.type === "auto_retry_end")
        retryEvents.push(event.type);
    });
    await session.prompt("Invoke once, then finish");
    const entries = manager.getEntries();
    const failures = entries.filter(
      (entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error",
    );
    expect(toolRuns).toBe(1);
    expect(wsRequests).toBe(2);
    expect(httpRequests).toBe(1);
    expect(retryEvents).toEqual(["auto_retry_start", "auto_retry_end"]);
    expect(failures).toHaveLength(2);
    const diagnostics = failures.map((entry) =>
      entry.message.role === "assistant"
        ? entry.message.diagnostics?.findLast((item) => item.type === "codex_failure")
        : undefined,
    );
    expect(diagnostics[0]).toMatchObject({
      transport: "websocket",
      phase: "after_message_stream_start",
      wsCloseCode: 1011,
    });
    expect(diagnostics[1]).toMatchObject({
      transport: "sse",
      status: 401,
      code: "invalid_api_key",
      requestId: "req_12345678",
    });
    for (const diagnostic of diagnostics) {
      expect(Object.keys(diagnostic ?? {}).sort()).toEqual(
        expect.arrayContaining([
          "type",
          "transport",
          "phase",
          "attempt",
          "brokerGeneration",
          "tokenExpiresAt",
        ]),
      );
      expect(
        Object.keys(diagnostic ?? {}).every((key) =>
          [
            "type",
            "timestamp",
            "transport",
            "phase",
            "attempt",
            "brokerGeneration",
            "tokenExpiresAt",
            "status",
            "code",
            "requestId",
            "wsCloseCode",
          ].includes(key),
        ),
      ).toBe(true);
    }
    expect(failures[0]?.message.role === "assistant" && failures[0].message.errorMessage).toBe(
      "WebSocket closed 1011 SECRET_WS_REASON",
    );
    expect(failures[1]?.message.role === "assistant" && failures[1].message.errorMessage).toBe(
      "SECRET_PROVIDER_TEXT",
    );
    const contexts = failures.map((entry) => {
      const mapped = mapPiEntry(entry)._unsafeUnwrap();
      if (mapped.type !== "message") throw new Error("expected mapped assistant message");
      return mapped.failure?.context;
    });
    expect(contexts[0]).toMatchObject({ transport: "websocket", wsCloseCode: 1011 });
    expect(contexts[1]).toMatchObject({
      transport: "sse",
      status: 401,
      code: "invalid_api_key",
      requestId: "req_12345678",
    });
    expect(JSON.stringify([diagnostics, contexts])).not.toContain("SECRET_PROVIDER_TEXT");
    expect(JSON.stringify([diagnostics, contexts])).not.toContain("SECRET_WS_REASON");
    expect(JSON.stringify([diagnostics, contexts])).not.toContain(token);
  } finally {
    session?.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
});
