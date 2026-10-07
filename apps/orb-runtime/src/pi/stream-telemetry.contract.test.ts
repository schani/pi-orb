import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { brokerProviderConfig } from "../broker/provider.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { createOrbExtensions } from "./extensions/index.ts";
import { createStreamTelemetryExtension } from "./extensions/stream-telemetry.ts";
import type { SubagentHost } from "./extensions/subagents.ts";
import { StreamTelemetry } from "./stream-telemetry.ts";

it("pins decoded WS message hooks, post-auth request start and absent summary/warming callbacks", () => {
  const codex = readFileSync(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses")),
    "utf8",
  );
  const parser = codex.slice(
    codex.indexOf("async function* parseWebSocket("),
    codex.indexOf("function requestBodyWithoutInput("),
  );
  expect(
    [...parser.matchAll(/socket.addEventListener\("([^"]+)"/g)].map((match) => match[1]),
  ).toEqual(["message", "error", "close"]);
  expect(parser).toContain("const parsed = JSON.parse(text);");
  expect(parser).toContain("queue.push(parsed);");
  expect(codex).toContain(
    "mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs), output, model, options?.onProviderStreamEvent)",
  );
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const runtime = readFileSync(fileURLToPath(new URL("./core/model-runtime.js", sdkEntry)), "utf8");
  const sdk = readFileSync(fileURLToPath(new URL("./core/sdk.js", sdkEntry)), "utf8");
  const summary = readFileSync(
    fileURLToPath(new URL("./core/compaction/compaction.js", sdkEntry)),
    "utf8",
  );
  expect(runtime).toContain("const resolution = await this.getAuth(model,");
  expect(runtime).toContain("const prepared = await this.prepareRequest(model, options);");
  expect(runtime).toContain(
    "return prepared.provider.streamSimple(prepared.model, transcript, prepared.options);",
  );
  expect(codex).toContain("await options?.onPayload?.(body, model)");
  expect(sdk).toContain("return runner.emitBeforeProviderRequest(payload);");
  const options = summary.slice(
    summary.indexOf("function createSummarizationOptions("),
    summary.indexOf("export async function completeSummarization("),
  );
  expect(options).not.toMatch(/onPayload|onResponse|onProviderStreamEvent/);
  expect(options).toContain(
    "const options = { maxTokens, signal, apiKey, headers, env, sessionId };",
  );
  expect(sdk).toContain("return modelRuntime.streamSimple(model, context, requestOptions);");
  expect(
    getBuiltinModels("openai-codex").every(
      (model) => !Object.values(model.promptCache ?? {}).some(Boolean),
    ),
  ).toBe(true);
});

it("installed Codex hook observes hidden toolarg bytes before native partial-JSON normalization", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("missing pinned Codex model");
  const telemetry = new StreamTelemetry(() => 100);
  const request = telemetry.start({
    requestId: "test",
    operationId: "op",
    sessionId: "root",
    attempt: 1,
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  const token = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "stream-contract" } })}.sig`;
  const call = { type: "function_call", id: "fc", call_id: "call", name: "hidden", arguments: "" };
  const events = [
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_item.added", output_index: 0, item: call },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc",
      output_index: 0,
      delta: '{"value":"秘密🔑"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: '{"value":"秘密🔑"}' },
    },
    { type: "response.done", response: { id: "resp_test", status: "completed", output: [] } },
  ];
  let normalizedArguments = 0;
  const stream = streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: token,
    transport: "sse",
    maxRetries: 0,
    fetch: async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
    onProviderStreamEvent: (event) => {
      telemetry.providerEvent(request, event);
      if ((event as { type: string }).type === "response.function_call_arguments.delta") {
        expect(normalizedArguments).toBe(0);
        expect(telemetry.snapshot()[0]?.toolArgumentBytes).toBe(22);
      }
    },
  });
  for await (const event of stream) {
    telemetry.normalizedEvent(request, event.type);
    if (event.type === "toolcall_delta") normalizedArguments++;
  }
  expect((await stream.result()).stopReason).toBe("toolUse");
  expect(normalizedArguments).toBe(1);
  expect(telemetry.snapshot()[0]?.events).toBe(5);
  expect(telemetry.snapshot()[0]?.lastEventType).toBe("response.done");
  expect(JSON.stringify(telemetry.snapshot())).not.toContain("秘密");
});

it.each(["root", "child"] as const)(
  "real native %s session counts preparse hidden generation and cleans up",
  async (scope) => {
    const dir = mkdtempSync(join(tmpdir(), "stream-session-contract-"));
    const telemetry = new StreamTelemetry(() => 100);
    const audits: unknown[] = [];
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    const token = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "stream-contract" } })}.sig`;
    const call = {
      type: "function_call",
      id: "fc",
      call_id: "call",
      name: "hidden",
      arguments: "",
    };
    const events = [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.output_item.added", output_index: 0, item: call },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc",
        output_index: 0,
        delta: `{"value":"${"x".repeat(1_048_576)}`,
      },
      { type: "response.failed", response: { error: { code: "test_failure", message: "SECRET" } } },
    ];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "agent", "auth.json"),
        allowModelNetwork: false,
      });
      runtime.registerProvider(
        "openai-codex",
        brokerProviderConfig(
          new NoSimulationTask("stream-contract", false),
          new BrokerTokenClient({
            requestToken: async () => ({
              kind: "grant",
              grant: {
                accessToken: token,
                accountId: "stream-contract",
                expiresAt: Date.now() + 3_600_000,
                generation: 1,
              },
            }),
          }),
          { inferenceBaseUrl: `http://127.0.0.1:${address.port}` },
        ),
      );
      await runtime.login("openai-codex", "oauth", {
        prompt: () => Promise.reject(new Error("unexpected prompt")),
        notify: () => {},
      });
      const manager = SessionManager.create(dir, join(dir, "sessions"));
      const streams = {
        telemetry,
        operationId: () => "op",
        rootSessionId: () => manager.getSessionId(),
        audit: (edge: import("./stream-telemetry.ts").StreamAudit) => {
          audits.push(edge);
          return ok(undefined);
        },
        failed: () => expect.fail("audit failed"),
      };
      const host: SubagentHost = {
        admitSubagent: (childId) => ok({ childId, operationId: "op" }),
        startSubagent: () => {},
        releaseSubagent: () => {},
        mayWakeSubagent: () => false,
        bindSubagentAbort: () => {},
        subagentAdapterFailed: (message) => expect.fail(message),
        abortOperation: async () => ok(undefined),
      };
      if (scope === "child") {
        vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
        mkdirSync(join(dir, "agent", "agents"), { recursive: true });
        writeFileSync(
          join(dir, "agent", "agents", "probe.md"),
          "---\nname: probe\ndescription: Stream telemetry fixture\ntools: []\n---\nFinish the test request.\n",
        );
        writeFileSync(
          join(dir, "agent", "settings.json"),
          JSON.stringify({
            transport: "sse",
            retry: { enabled: false },
            compaction: { enabled: false },
            defaultProjectTrust: "never",
          }),
        );
      }
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: join(dir, "agent"),
        noExtensions: true,
        extensionFactories:
          scope === "child"
            ? createOrbExtensions({ cwd: dir, subagents: host, streams })
            : [{ name: "stream-test", factory: createStreamTelemetryExtension(streams) }],
      });
      await loader.reload();
      const model = runtime.getModels("openai-codex")[0];
      if (!model) throw new Error("missing Codex model");
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: join(dir, "agent"),
        modelRuntime: runtime,
        model,
        sessionManager: manager,
        resourceLoader: loader,
        settingsManager: SettingsManager.inMemory({ transport: "sse", retry: { enabled: false } }),
        tools: [],
      }));
      await session.bindExtensions({ mode: "print", onError: (error) => expect.fail(error.error) });
      if (scope === "child") {
        const service = getSubagentsService();
        if (!service) throw new Error("missing installed native subagent service");
        const id = service.spawn("probe", "SECRET CHILD PROMPT");
        await service.waitForAll();
        const record = service.getRecord(id);
        expect(record?.status).toBe("error");
        expect(record?.error).toContain("SECRET");
        if (!record?.outputFile) throw new Error("missing native child session file");
        const childId = SessionManager.open(record.outputFile).getSessionId();
        expect(childId).not.toBe(manager.getSessionId());
        expect(audits).toMatchObject([
          {
            sessionId: childId,
            parentSessionId: manager.getSessionId(),
            operationId: "op",
            attempt: 1,
          },
          { sessionId: childId, parentSessionId: manager.getSessionId() },
        ]);
      } else {
        const gate = () => {
          let resolve = () => {};
          const promise = new Promise<void>((done) => {
            resolve = done;
          });
          return { promise, resolve: () => resolve() };
        };
        const entered = gate();
        const released = gate();
        const getAuth = runtime.getAuth.bind(runtime);
        const auth = vi.spyOn(runtime, "getAuth").mockImplementation(async (model, options) => {
          entered.resolve();
          await released.promise;
          return getAuth(model, options);
        });
        const completion = session.prompt("SECRET PROMPT");
        await entered.promise;
        const whileAuthenticating = telemetry.snapshot();
        released.resolve();
        await completion;
        auth.mockRestore();
        expect(whileAuthenticating).toEqual([]);
      }
      expect(audits).toMatchObject([
        {
          edge: "large_tool_arguments",
          toolArgumentBytes: 1_048_586,
          normalizedEvents: 1,
          normalizedToolArgumentEvents: 0,
        },
        { edge: "terminal", terminal: "failed" },
      ]);
      expect(telemetry.snapshot()).toEqual([]);
      expect(JSON.stringify(audits)).not.toContain("SECRET");
    } finally {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      if (scope === "child") vi.unstubAllEnvs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
