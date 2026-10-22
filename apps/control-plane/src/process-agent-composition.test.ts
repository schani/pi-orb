import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { DurableAgent } from "./adapters/durable/agent.ts";
import { durableError } from "./adapters/durable/manager.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { RemoteExecutionEnv } from "./adapters/execution-client/env.ts";
import * as brokerDomain from "./domain/broker.ts";
import {
  admitProcessAgentResources,
  closeProcessAgentResources,
  mcpFetchSignal,
  processAgentContext,
  processAgentSystemContext,
  processMcpDiscoveryDiagnostics,
  createProcessAgentContext as productionCreateProcessAgentContext,
  refreshProcessTools,
  scopedMcpAuth,
  scopedMcpHeaders,
} from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "./testkit/fixtures.ts";

function createProcessAgentContext(
  ...args: Parameters<typeof productionCreateProcessAgentContext>
) {
  const open = productionCreateProcessAgentContext(args[0], {
    ...args[1],
    resources: {
      acquire: (_task, orb) =>
        okAsync({
          orbId: orb.id,
          commitSha: "a".repeat(40),
          instructionPath: null,
          skillRoot: null,
          files: [],
        }),
    },
  });
  return (...inputs: Parameters<typeof open>) =>
    open(
      inputs[0],
      inputs[1],
      inputs[2],
      inputs[3],
      inputs[4] ?? {
        storage: new MemoryStorage(),
        signal: new AbortController().signal,
        check: () => okAsync(undefined),
        checkInputAdmission: () => okAsync(undefined),
        beginDrain: () => okAsync(undefined),
        release: () => okAsync(undefined),
        artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
      },
    );
}

describe("process agent composition", () => {
  it("retains discovery phase evidence only for failed startup attempts", () => {
    const task = new NoSimulationTask("discovery-diagnostics", false);
    const clock = vi.spyOn(task, "monotonicNow").mockReturnValue(150);
    const log = vi.spyOn(task, "log").mockImplementation(() => {});
    const diagnostics = processMcpDiscoveryDiagnostics(task, "orb", 7, 100);
    const started = {
      attempt: 1,
      server: "fixture",
      serverOrdinal: 1,
      serverTotal: 2,
      phase: "initialize" as const,
      outcome: "started" as const,
      elapsedMs: 0,
      discoveryElapsedMs: 0,
      aborted: false,
    };
    try {
      diagnostics.record(started);
      expect(log).not.toHaveBeenCalled();
      clock.mockReturnValue(170);
      diagnostics.record({
        ...started,
        outcome: "aborted",
        elapsedMs: 20,
        discoveryElapsedMs: 20,
        aborted: true,
      });
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]?.[0]).toContain("composition_elapsed_ms=50");
      expect(log.mock.calls[1]?.[0]).toContain("outcome=aborted");
      expect(log.mock.calls[1]?.[0]).toContain("composition_elapsed_ms=70");
      expect(log.mock.calls[1]?.[0]).toContain("phase_elapsed_ms=20");
      expect(log.mock.calls[1]?.[0]).toContain("discovery_elapsed_ms=20");
      diagnostics.finish?.(1);
      diagnostics.record(started);
      expect(log).toHaveBeenCalledTimes(2);
      diagnostics.record({ ...started, outcome: "failed", errorCategory: "unavailable" });
      expect(log).toHaveBeenCalledTimes(4);
      const healthy = processMcpDiscoveryDiagnostics(task, "orb", 7, 100);
      healthy.record(started);
      healthy.record({ ...started, outcome: "completed" });
      healthy.finish?.(1);
      expect(log).toHaveBeenCalledTimes(4);
    } finally {
      log.mockRestore();
      clock.mockRestore();
    }
  });
  it("opens without MCP network and uses fresh SDK auth admission after opening cancellation", async () => {
    const harness = makeHarness();
    const orb = makeOrbRow("central", "project", "starting", {
      hostRef: "executor",
      initialModel: { provider: "openai-codex", id: "gpt-6-astra" },
    });
    harness.store.seedProject(makeProjectRow("project"));
    harness.store.seedOrb(orb);
    const opening = new AbortController();
    const renewal = new AbortController();
    const task = new NoSimulationTask("central-auth-context", false);
    const clock = vi.spyOn(task, "monotonicNow").mockReturnValue(1000);
    const broker = { constants: { requestDeadlineMs: 123 } };
    const brokerForUser = vi.fn((_ownerUserId: string) => broker);
    const token = vi.spyOn(brokerDomain, "getToken").mockResolvedValue(
      ok({
        accessToken: "owner-grant",
        expiresAt: 9999999999999,
        generation: 1,
      } as never),
    );
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync({ getModel: () => undefined } as never));
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("MCP must not connect during startup"));
    try {
      const open = createProcessAgentContext(harness.deps, {
        mcp: {
          read: () =>
            okAsync({ servers: [{ name: "hung", url: "https://mcp.invalid", headers: {} }] }),
        },
        brokerForUser,
      } as never);
      const result = await open(task, orb, { signal: opening.signal });
      expect(result.isOk()).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(result._unsafeUnwrap().initialSettings).toEqual({
        model: { provider: "openai-codex", id: "gpt-6-astra" },
        thinkingLevel: "high",
      });
      const options = models.mock.calls[0]?.[0];
      expect(options).toBeDefined();
      await options?.token(options.signal);
      expect(token.mock.calls[0]?.[4]).toMatchObject({ deadlineAt: 1123 });
      opening.abort();
      clock.mockReturnValue(10000);
      await options?.token(renewal.signal);
      expect(token.mock.calls[1]?.[4]).toEqual({ signal: renewal.signal, deadlineAt: 10123 });
      expect(renewal.signal.aborted).toBe(false);
      expect(brokerForUser).toHaveBeenCalledWith(TEST_USER_ID);
      expect(brokerForUser.mock.calls.every(([owner]) => owner === TEST_USER_ID)).toBe(true);
      if (result.isOk()) await result.value.closeResources?.();
    } finally {
      clock.mockRestore();
      token.mockRestore();
      models.mockRestore();
      fetcher.mockRestore();
    }
  });
  it("opens CP models and tools while execution readiness is held", async () => {
    const harness = makeHarness();
    const orb = makeOrbRow("central", "project", "starting", { hostRef: "executor" });
    harness.store.seedProject(makeProjectRow("project"));
    harness.store.seedOrb(orb);
    const binding = { baseUrl: "http://executor", token: "token", incarnation: "0", cwd: "/repo" };
    const initializationHealth = {
      v: 1 as const,
      orbId: orb.id,
      runtimeInstanceId: "execution",
      status: "initializing" as const,
      phase: "setup_running" as const,
      hooks: {},
    };
    const ready = vi.spyOn(RemoteExecutionEnv.prototype, "ready").mockResolvedValue(
      err({
        type: "execution_transport_error",
        code: "unavailable",
        message: "execution initializing",
        initializationHealth,
      }),
    );
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync({ getModel: () => undefined } as never));
    try {
      const open = createProcessAgentContext(
        {
          ...harness.deps,
          hostProvider: { ...harness.deps.hostProvider, executionBinding: () => okAsync(binding) },
        },
        { mcp: { read: () => okAsync({ servers: [] }) } } as never,
      );
      const result = await open(new NoSimulationTask("initializing-composition", false), orb, {
        signal: new AbortController().signal,
      });
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(models).toHaveBeenCalledOnce();
      expect(ready).not.toHaveBeenCalled();
      if (result.isOk()) {
        expect(result.value.instructions).not.toMatch(/pending|<cwd>/i);
        await result.value.closeResources?.();
      }
    } finally {
      ready.mockRestore();
      models.mockRestore();
    }
  });

  it("can inspect a drained sleeping owner without reopening revoked input admission", async () => {
    const h = makeHarness();
    const orb = makeOrbRow("sleeping", "project", "running");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(createModels() as never));
    const task = new NoSimulationTask("sleep drain inspection", false);
    const open = createProcessAgentContext(h.deps, {
      mcp: { read: () => okAsync({ servers: [] }) },
    } as never);
    const opened = await open(task, orb, { signal: new AbortController().signal });
    expect(opened.isOk(), opened.isErr() ? opened.error.message : "").toBe(true);
    const options = opened._unsafeUnwrap();
    const started = await DurableAgent.open({
      ...options,
      orbId: orb.id,
      storage: new MemoryStorage(),
    });
    expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
    const agent = started._unsafeUnwrap();
    try {
      (await agent.waitForIdle())._unsafeUnwrap();
      h.store.seedOrb({ ...orb, state: "stopping", stopReason: "sleep", stateVersion: 1 });
      expect((await options.checkAdmission?.())?.isErr()).toBe(true);
      const prepared = await agent.prepareIdleStop();
      expect(prepared.isOk(), prepared.isErr() ? prepared.error.message : "").toBe(true);
      expect(prepared._unsafeUnwrap()).toEqual({ v: 1, prepared: true });
      expect(
        (
          await agent.deliver({
            baseUrl: "central",
            messageId: "bypass",
            messageIds: [],
            content: [{ type: "text", text: "bypass" }],
          })
        ).isErr(),
      ).toBe(true);
    } finally {
      await agent.close();
      models.mockRestore();
    }
  });

  it("opens archival authority only for immutable read-only history, retaining epoch fencing", async () => {
    const h = makeHarness();
    const orb = makeOrbRow("archival", "project", "archiving");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    h.deps.control.markStopping(orb.id, orb.stateVersion);
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(createModels() as never));
    const open = createProcessAgentContext(h.deps, {
      mcp: { read: () => okAsync({ servers: [] }) },
    } as never);
    const task = new NoSimulationTask("archival reader composition", false);
    const context = { signal: new AbortController().signal };
    try {
      expect((await open(task, orb, context)).isErr()).toBe(true);
      const opened = await open(task, orb, context, true);
      expect(opened.isOk(), opened.isErr() ? opened.error.message : "").toBe(true);
      const options = opened._unsafeUnwrap();
      expect(options.resume).toBe(false);
      const agent = (
        await DurableAgent.open({ ...options, orbId: orb.id, storage: new MemoryStorage() })
      )._unsafeUnwrap();
      try {
        agent.resume();
        expect(agent.workActive()).toBe(false);
        expect((await agent.appendAlert("late", "late")).isErr()).toBe(true);
        h.store.seedOrb({ ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 });
        expect((await options.checkAdmission?.())?.isErr()).toBe(true);
        expect(h.world.hostCount(orb.id)).toBe(0);
      } finally {
        await agent.close();
      }
    } finally {
      models.mockRestore();
    }
  });

  it("checks execution metadata before publishing ready compute without changing pinned instructions", async () => {
    const harness = makeHarness();
    const orb = makeOrbRow("central", "project", "running", { hostRef: "executor" });
    harness.store.seedProject(makeProjectRow("project"));
    harness.store.seedOrb(orb);
    const binding = { baseUrl: "http://executor", token: "token", incarnation: "0", cwd: "/repo" };
    const hooks = {
      setup: {
        hook: "setup" as const,
        outcome: "failed" as const,
        exitCode: 3,
        incarnation: "0",
        startedAt: "2026-08-06T00:00:00Z",
        endedAt: "2026-08-06T00:00:01Z",
        logPath: "/home/.cache/pi-orb/logs/setup.log",
      },
    };
    const ready = vi.spyOn(RemoteExecutionEnv.prototype, "ready").mockResolvedValue(
      ok({
        ...binding,
        pid: 1,
        checkoutCommit: "commit",
        hooks,
      }),
    );
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync({ getModel: () => undefined } as never));
    try {
      const open = createProcessAgentContext(
        {
          ...harness.deps,
          hostProvider: { ...harness.deps.hostProvider, executionBinding: () => okAsync(binding) },
        },
        { mcp: { read: () => okAsync({ servers: [] }) } } as never,
      );
      const result = await open(new NoSimulationTask("hooks-composition", false), orb, {
        signal: new AbortController().signal,
      });
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (result.isErr()) return;
      const instructions = result.value.instructions;
      expect(ready).not.toHaveBeenCalled();
      expect((await result.value.checkExecutionReady?.(BACKGROUND_CONTEXT))?.isOk()).toBe(true);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(result.value.instructions).toBe(instructions);
      harness.store.seedOrb({ ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 });
      expect((await result.value.checkExecutionReady?.(BACKGROUND_CONTEXT))?.isErr()).toBe(true);
      await result.value.closeResources?.();
    } finally {
      ready.mockRestore();
      models.mockRestore();
    }
  });

  it("supplies lifecycle edges without an eventual transcript write callback", async () => {
    const harness = makeHarness();
    const orb = makeOrbRow("central", "project", "running");
    harness.store.seedOrb(orb);
    const task = new NoSimulationTask("composition", false);
    const options = {
      env: {},
      models: {},
      registry: {},
      checkoutCommit: "commit",
      instructions: "instructions",
    };
    const open = processAgentContext(harness.deps, () => okAsync(options as never));
    const result = await open(task, orb, { signal: new AbortController().signal });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.checkoutCommit).toBe("commit");
    expect(result.value.edge).toBeTypeOf("function");
    expect(result.value.commitHistory).toBeUndefined();
  });

  it("honors both caller cancellation and the SDK cleanup timeout", async () => {
    const caller = new AbortController();
    const request = new AbortController();
    const joined = mcpFetchSignal(caller.signal, request.signal);
    request.abort();
    expect(joined?.aborted).toBe(true);
    const otherRequest = new AbortController();
    const other = mcpFetchSignal(caller.signal, otherRequest.signal);
    caller.abort();
    expect(other?.aborted).toBe(true);
    const opening = new AbortController();
    const client = new McpClient({ name: "test", version: "1" });
    let deleteSignal: AbortSignal | null | undefined;
    let entered!: () => void;
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = new StreamableHttpTransport({
      url: "https://mcp.invalid",
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          deleteSignal = mcpFetchSignal(opening.signal, init.signal);
          entered();
          await new Promise<void>((resolve) =>
            deleteSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return new Response(null, { status: 204 });
        }
        const message = JSON.parse(String(init?.body));
        return message.method === "initialize"
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
              }),
              { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session" } },
            )
          : new Response(null, { status: 202 });
      },
    });
    await client.connect(transport);
    const closed = client.close();
    await deleting;
    expect(deleteSignal?.aborted).toBe(false);
    // Node's AbortSignal.timeout uses platform timers, not Vitest's fake clock.
    await closed;
    expect(deleteSignal?.aborted).toBe(true);
    expect(opening.signal.aborted).toBe(false);
  });

  it.each(["http", "network", "credential"] as const)(
    "records sanitized %s failure at the MCP adapter boundary",
    async (failure) => {
      const h = makeHarness();
      const orb = makeOrbRow("central", "project", "starting");
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(orb);
      const task = new NoSimulationTask("mcp-failure", false);
      const log = vi.spyOn(task, "log").mockImplementation(() => {});
      const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "network") throw new Error("SECRET URL TOKEN");
        return new Response(null, { status: 503 });
      });
      const models = vi
        .spyOn(durableModels, "createDurableModels")
        .mockReturnValue(okAsync({ getModel: () => undefined } as never));
      try {
        const open = createProcessAgentContext(h.deps, {
          mcp: {
            read: () =>
              okAsync({
                servers: [
                  {
                    name: "fixture",
                    url: "https://mcp.invalid",
                    headers: {},
                    ...(failure === "credential" ? { oauth: { id: "auth" } } : {}),
                  },
                ],
              }),
          },
          mcpOAuth: { token: async () => err({ type: "mcp_oauth_error", code: "auth_required" }) },
        } as never);
        const result = await open(task, orb, { signal: new AbortController().signal });
        expect(result.isOk()).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        if (result.isErr()) return;
        const discover = result.value.registry
          .snapshot()
          .tools()
          .find(({ tool }) => tool.name === "mcp_discover")?.tool;
        expect(discover).toBeDefined();
        const output = await discover?.execute(
          { server: "fixture" },
          { diagnostic: () => {} } as never,
          BACKGROUND_CONTEXT,
        );
        expect(JSON.stringify(output)).toContain(
          failure === "credential" ? "needs-auth" : "unavailable",
        );
        const lines = log.mock.calls.map(([line]) => line).join("\n");
        expect(lines).toContain(
          `errorCategory=${failure === "credential" ? "auth_required" : failure}`,
        );
        if (failure === "http") expect(lines).toContain("http_status=503");
        expect(lines).not.toContain("SECRET");
        expect(lines).not.toContain("https://");
        await result.value.closeResources?.();
      } finally {
        log.mockRestore();
        fetcher.mockRestore();
        models.mockRestore();
      }
    },
  );

  it("keeps recovered authorization challenges and unsupported cleanup silent", async () => {
    const h = makeHarness();
    const orb = makeOrbRow("central", "project", "starting");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    const task = new NoSimulationTask("mcp-healthy", false);
    const log = vi.spyOn(task, "log").mockImplementation(() => {});
    let initializes = 0;
    let deletes = 0;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") {
        deletes++;
        return new Response(null, { status: 405 });
      }
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      if (message.method !== "initialize") return new Response(null, { status: 202 });
      if (++initializes === 1) return new Response(null, { status: 401 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }),
        { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session" } },
      );
    });
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync({ getModel: () => undefined } as never));
    try {
      const open = createProcessAgentContext(h.deps, {
        mcp: {
          read: () =>
            okAsync({
              servers: [
                { name: "fixture", url: "https://mcp.invalid", headers: {}, oauth: { id: "auth" } },
              ],
            }),
        },
        mcpOAuth: {
          token: async () => ok({ accessToken: "token", generation: 1, expiresAt: 9999999999999 }),
        },
      } as never);
      const result = await open(task, orb, { signal: new AbortController().signal });
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      const discover = result.value.registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "mcp_discover")?.tool;
      const output = await discover?.execute(
        { server: "fixture" },
        { diagnostic: () => {} } as never,
        BACKGROUND_CONTEXT,
      );
      expect(JSON.stringify(output)).toContain("available");
      expect(initializes).toBe(2);
      expect(deletes).toBe(1);
      expect(log.mock.calls.map(([line]) => line).join("\n")).not.toContain("durable.mcp_");
      await result.value.closeResources?.();
    } finally {
      models.mockRestore();
      fetcher.mockRestore();
      log.mockRestore();
    }
  });

  it("installs explicitly discovered tools for subsequent root and child scripts", async () => {
    const h = makeHarness();
    const orb = makeOrbRow("central", "project", "starting");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const modelFactory = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(models as never));
    const methods: string[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const message = JSON.parse(String(init?.body));
      methods.push(message.method);
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "pong" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    let harness: Harness | undefined;
    let options: Awaited<ReturnType<ReturnType<typeof createProcessAgentContext>>> | undefined;
    try {
      const open = createProcessAgentContext(h.deps, {
        mcp: {
          read: () =>
            okAsync({
              servers: ["root", "child"].map((name) => ({
                name,
                url: "https://mcp.invalid",
                headers: {},
              })),
            }),
        },
      } as never);
      options = await open(new NoSimulationTask("mcp-registration", false), orb, {
        signal: new AbortController().signal,
      });
      expect(options.isOk()).toBe(true);
      if (options.isErr()) return;
      const config = options.value;
      const childExtension = config.childExtension;
      expect(childExtension).toBeDefined();
      if (!childExtension) return;
      harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: config.registry },
        BACKGROUND_CONTEXT,
      );
      config.bindNativeConversation?.(harness.conversation.bind(harness));
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          modelTools: config.modelTools ?? [],
          extensions: { remove: [childExtension] },
        },
      });
      const child = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "faux", modelId: "faux-1" },
            tools: childExtension.tools ?? [],
            modelTools: config.modelTools ?? [],
            extensions: {
              remove: config.registry
                .snapshot()
                .installed()
                .filter((extension) => extension.name !== childExtension.name),
            },
          },
        },
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      for (const [conversation, server] of [
        [root, "root"],
        [child, "child"],
      ] as const) {
        for (const code of [
          `text(await tools.mcp_discover({server:${JSON.stringify(server)}}));`,
          `text(await describeTool("mcp__${server}__ping")); text(await tools.mcp__${server}__ping({}));`,
        ]) {
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
            fauxAssistantMessage("done"),
          ]);
          await (
            await conversation.submit({ type: "input", content: "run" }, BACKGROUND_CONTEXT)
          ).wait(BACKGROUND_CONTEXT);
        }
        const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
        expect(JSON.stringify(entries.items)).toContain("pong");
      }
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
    } finally {
      await harness?.close(BACKGROUND_CONTEXT);
      if (options?.isOk()) await options.value.closeResources?.();
      modelFactory.mockRestore();
      fetcher.mockRestore();
    }
  });

  it("resolves literal and scoped static MCP headers without missing-secret fallback", () => {
    const server = {
      headers: {
        Authorization: { secret: "KEY", prefix: "Bearer " as const },
        "X-Mode": { literal: "local" },
      },
    };
    expect(scopedMcpHeaders(server.headers, { KEY: "scoped" })._unsafeUnwrap()).toEqual({
      Authorization: "Bearer scoped",
      "X-Mode": "local",
    });
    expect(scopedMcpHeaders(server.headers, {}).isErr()).toBe(true);
  });

  it("attempts execution cleanup when tool cleanup fails", async () => {
    let cleaned = false;
    const result = await closeProcessAgentResources(
      { close: () => errAsync({ code: "unavailable" as const, message: "tools close failed" }) },
      {
        cleanup: async () => {
          cleaned = true;
        },
      },
    );
    expect(cleaned).toBe(true);
    expect(result.isErr()).toBe(true);
  });

  it("refreshes the local native view without MCP discovery before code execution", async () => {
    const execute = vi.fn(async () => ({ output: [{ type: "text" as const, text: "local" }] }));
    const tool = refreshProcessTools({
      name: "codemode",
      description: "code",
      parameters: Type.Object({}),
      execute,
    });
    expect(await tool.execute({}, {} as never, BACKGROUND_CONTEXT)).toEqual({
      output: [{ type: "text", text: "local" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not execute code when the native MCP view cannot refresh", async () => {
    const execute = vi.fn(async () => ({}));
    const tool = refreshProcessTools(
      { name: "codemode", description: "code", parameters: Type.Object({}), execute },
      () => errAsync({ code: "unavailable", message: "PRIVATE-NATIVE-REFRESH-FAILURE" }),
    );
    expect(await tool.execute({}, {} as never, BACKGROUND_CONTEXT)).toEqual({
      isError: true,
      output: [{ type: "text", text: "Tool catalog unavailable" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports authorization-required when standalone MCP credentials are rejected", async () => {
    const statuses: string[] = [];
    const provider = scopedMcpAuth(
      () => errAsync({ code: "forbidden", message: "secret credential failure" }),
      (state) => {
        statuses.push(state);
      },
    );
    await expect(provider.token()).rejects.toThrow("MCP credential unavailable");
    expect(statuses).toEqual(["needs-auth"]);
  });

  it("uses rejected token generation for native MCP auth retry", async () => {
    const reasons: unknown[] = [];
    const provider = scopedMcpAuth((request) => {
      reasons.push(request);
      return okAsync({
        accessToken: reasons.length === 1 ? "old" : "new",
        accountId: "owner",
        generation: reasons.length,
        expiresAt: 100,
      });
    });
    expect(await provider.token()).toBe("old");
    await provider.onUnauthorized?.({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL("https://mcp.example"),
      fetch,
      token: "old",
    });
    expect(reasons).toEqual([{ reason: "startup" }, { reason: "rejected", staleGeneration: 1 }]);
  });

  it("rejects admission aborted before registry installation and cleans both resources", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleaned: string[] = [];
    const discovery = admitProcessAgentResources(
      {
        close: () => {
          cleaned.push("tools");
          return okAsync(undefined);
        },
      },
      {
        cleanup: async () => {
          cleaned.push("env");
        },
      },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      () => ResultAsync.fromSafePromise(admission),
    );
    controller.abort();
    release?.();
    const result = await discovery;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("cancelled");
    expect(cleaned).toEqual(["tools", "env"]);
  });

  it("rejects revoked admission before registry installation and cleans both resources", async () => {
    const cleaned: string[] = [];
    const result = await admitProcessAgentResources(
      {
        close: () => {
          cleaned.push("tools");
          return okAsync(undefined);
        },
      },
      {
        cleanup: async () => {
          cleaned.push("env");
        },
      },
      BACKGROUND_CONTEXT,
      () => errAsync(durableError("owner changed")),
    );
    expect(result.isErr()).toBe(true);
    expect(cleaned).toEqual(["tools", "env"]);
  });

  it("preserves timezone with generic tool guidance", () => {
    const system = processAgentSystemContext("Asia/Tokyo");
    expect(system).toContain("User’s time zone: Asia/Tokyo");
    expect(system).toContain("Use codemode to compose tool calls.");
    expect(system).not.toMatch(/orb_spawn|subagent/i);
  });
});
