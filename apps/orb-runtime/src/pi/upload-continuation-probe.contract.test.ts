import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const command =
  "find ../uploads -name e2e-upload.bin -exec sha256sum {} \\; && find ../uploads -name e2e-sidecar.txt -exec cat {} \\;";
// Fixed data only; no persisted or environment credentials.
const token = `probe.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "probe" } })).toString("base64url")}.probe`;
const model: Model<"openai-codex-responses"> = {
  id: "upload-probe",
  name: "Upload probe",
  provider: "upload-probe",
  api: "openai-codex-responses",
  baseUrl: "https://upload-probe.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const uploadHash = createHash("sha256")
  .update(Buffer.alloc(4 * 1024 * 1024 + 13, 0xa7))
  .digest("hex");
const argumentsJson = JSON.stringify({ command });
// Shapes copied from the captured fake-engine.ts buildTurn toolCall branch.
const item = { type: "function_call", id: "fc_probe", call_id: "call_probe", name: "bash" };
const prefix = [
  { type: "response.created", response: { id: "resp_probe" } },
  { type: "response.output_item.added", output_index: 0, item },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
  { type: "response.function_call_arguments.done", output_index: 0, arguments: argumentsJson },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { ...item, arguments: argumentsJson },
  },
];
const terminal = {
  type: "response.completed",
  response: { id: "resp_probe", status: "completed" },
};
const encode = (events: unknown[]) =>
  new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  "success",
  "failure",
  "missing-terminal",
  "interrupted-stream",
  "interrupted-tool",
] as const)("real Codex SDK upload continuation: %s", async (outcome) => {
  const networkGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected network attempt in upload probe");
  });
  const dir = mkdtempSync(join(tmpdir(), "orb-upload-probe-"));
  const edges: string[] = [];
  const awaitingTerminal = gate();
  const toolEntered = gate();
  const toolRelease = gate();
  const continuation = gate();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let requests = 0;
  let continuationBody = "";
  let cancelled = false;
  let eof = false;
  let detachAbort = () => {};
  const watchdogs = new Set<ReturnType<typeof setTimeout>>();
  const closeBody = () => {
    if (!cancelled && !eof) {
      eof = true;
      controller.close();
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        value.enqueue(encode(prefix));
      },
      pull() {
        edges.push("transport:read-awaiting-terminal");
        awaitingTerminal.release();
      },
      cancel() {
        cancelled = true;
        detachAbort();
        edges.push("transport:client-cancel");
      },
    },
    { highWaterMark: 0 },
  );
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let running: Promise<void> | undefined;
  let settled = false;
  const interruption = new Error("Intentional probe interruption");
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
      apiKey: token,
      baseUrl: model.baseUrl,
      models: [model],
    });
    await runtime.setRuntimeApiKey(model.provider, token);
    const settings = SettingsManager.inMemory();
    settings.setRetryEnabled(false);
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      systemPromptOverride: () => "Fixed upload probe",
      extensionFactories: [],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: settings,
      resourceLoader: loader,
      model,
      tools: ["bash"],
      customTools: [
        createBashToolDefinition(dir, {
          operations: {
            exec: async (received, _cwd, options) => {
              expect(received).toBe(command);
              edges.push("bash:operations-enter");
              toolEntered.release();
              await toolRelease.promise;
              options.onData(
                Buffer.from(
                  outcome === "success"
                    ? `${uploadHash}  ../uploads/e2e-upload.bin\nUPLOAD_SIDECAR`
                    : "fixed failure",
                ),
              );
              edges.push("bash:operations-complete");
              return { exitCode: outcome === "success" ? 0 : 1 };
            },
          },
        }) as ToolDefinition,
      ],
    }));
    session.subscribe((event) => {
      edges.push(`client:${event.type}`);
      if (event.type === "tool_execution_end")
        edges.push(`tool-result:${JSON.stringify(event.result).slice(0, 1000)}`);
    });
    vi.spyOn(runtime, "streamSimple").mockImplementation((requestedModel, context, options) =>
      streamSimple(
        requestedModel as Parameters<typeof streamSimple>[0],
        normalizeContext(context),
        {
          ...options,
          apiKey: token,
          transport: "sse",
          maxRetries: 0,
          onPayload: (payload) => {
            if (requests === 1) continuationBody = JSON.stringify(payload);
          },
          onProviderStreamEvent: (event) => {
            edges.push(`provider-consumed:${(event as { type: string }).type}`);
          },
          fetch: async (_url, init) => {
            requests += 1;
            edges.push(`request:${requests}:ack-200`);
            if (requests === 1) {
              const signal = init?.signal;
              const abortBody = () => {
                edges.push("transport:abort");
                closeBody();
              };
              signal?.addEventListener("abort", abortBody, { once: true });
              detachAbort = () => signal?.removeEventListener("abort", abortBody);
              if (signal?.aborted) abortBody();
              return new Response(body, { headers: { "content-type": "text/event-stream" } });
            }
            expect(init?.method).toBe("POST");
            continuation.release();
            const message = {
              type: "message",
              id: "msg_probe",
              content: [{ type: "output_text", text: "PROBE_CONTINUED" }],
            };
            return new Response(
              encode([
                { type: "response.created", response: { id: "resp_continuation" } },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "msg_probe" },
                },
                { type: "response.output_text.delta", output_index: 0, delta: "PROBE_CONTINUED" },
                { type: "response.output_item.done", output_index: 0, item: message },
                {
                  type: "response.completed",
                  response: { id: "resp_continuation", status: "completed" },
                },
              ]),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      ),
    );
    const prompt = session.prompt("The user uploaded files: fixed probe").finally(() => {
      expect(globalThis.fetch).toBe(networkGuard);
      settled = true;
    });
    running = prompt;
    const until = async (edge: Promise<void>, label: string) => {
      let watchdog!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          edge,
          prompt.then(() => {
            throw new Error(
              `Turn ended before ${label}: ${JSON.stringify({ edges: edges.slice(-40), messages: session?.messages.slice(-1) })}`,
            );
          }),
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(() => {
              reject(
                new Error(`Probe stalled before ${label}: ${JSON.stringify(edges.slice(-40))}`),
              );
            }, 2_000);
            watchdogs.add(watchdog);
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
        watchdogs.delete(watchdog);
      }
    };
    await until(awaitingTerminal.promise, "terminal read");
    expect(edges).toContain("provider-consumed:response.output_item.done");
    expect(edges).not.toContain("bash:operations-enter");
    expect(requests).toBe(1);
    if (outcome === "interrupted-stream") throw interruption;
    if (outcome === "missing-terminal") {
      eof = true;
      edges.push("transport:eof-release");
      controller.close();
      await running;
      expect(edges).not.toContain("bash:operations-enter");
      expect(edges).not.toContain("client:tool_execution_start");
      expect(requests).toBe(1);
      expect(JSON.stringify(session.messages)).toContain(
        "stream ended before a terminal response event",
      );
    } else {
      edges.push("transport:terminal-release");
      controller.enqueue(encode([terminal]));
      await until(toolEntered.promise, "tool entry");
      expect(edges).toContain("provider-consumed:response.completed");
      expect(eof).toBe(false);
      expect(cancelled).toBe(true);
      expect(edges.indexOf("transport:client-cancel")).toBeLessThan(
        edges.indexOf("bash:operations-enter"),
      );
      expect(requests).toBe(1);
      expect(edges).not.toContain("client:tool_execution_end");
      if (outcome === "interrupted-tool") throw interruption;
      toolRelease.release();
      await until(continuation.promise, "continuation request");
      await running;
      expect(requests).toBe(2);
      expect(edges).toContain("client:tool_execution_end");
      expect(edges.indexOf("client:tool_execution_end")).toBeLessThan(
        edges.indexOf("request:2:ack-200"),
      );
      expect(continuationBody).toContain(
        outcome === "success" ? "UPLOAD_SIDECAR" : "fixed failure",
      );
      expect(continuationBody).toContain('"type":"function_call_output"');
      expect(new RegExp(`${uploadHash}[\\s\\S]*UPLOAD_SIDECAR`).test(continuationBody)).toBe(
        outcome === "success",
      );
      const toolResult = session.messages.find((message) => message.role === "toolResult");
      expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(outcome === "failure");
    }
  } catch (error) {
    if (error !== interruption) throw error;
    expect(outcome.startsWith("interrupted-")).toBe(true);
  } finally {
    awaitingTerminal.release();
    toolEntered.release();
    toolRelease.release();
    continuation.release();
    closeBody();
    try {
      try {
        await session?.abort();
      } finally {
        await running;
      }
      if (running) expect(settled).toBe(true);
    } finally {
      detachAbort();
      for (const watchdog of watchdogs) clearTimeout(watchdog);
      session?.dispose();
      const evidenceDir =
        ".context/consolidation/minimal-actions-release-20261005/upload-local-probe";
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, `${outcome}.json`),
        JSON.stringify({ outcome, eof, cancelled, requests, edges, continuationBody }, null, 2),
      );
      rmSync(dir, { recursive: true, force: true });
      const networkCalls = networkGuard.mock.calls.length;
      vi.restoreAllMocks();
      expect(networkCalls).toBe(0);
    }
  }
});
