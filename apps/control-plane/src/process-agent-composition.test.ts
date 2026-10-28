import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { fetch as localFetch, MockAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { DurableAgent } from "./adapters/durable/agent.ts";
import { durableError } from "./adapters/durable/manager.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { RemoteExecutionEnv } from "./adapters/execution-client/env.ts";
import * as brokerDomain from "./domain/broker.ts";
import { putProjectSecret } from "./domain/project-secrets.ts";
import {
  admitProcessTools,
  closeProcessAgentResources,
  processAgentContext,
  processAgentSystemContext,
  createProcessAgentContext as productionCreateProcessAgentContext,
  refreshProcessTools,
  scopedMcpAuth,
  scopedMcpHeaders,
} from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "./testkit/fixtures.ts";
import { FakeProjectSecretPointerStore } from "./testkit/project-secrets.ts";

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
  it("uses fresh SDK auth admission after the opening operation is cancelled", async () => {
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
    try {
      const open = createProcessAgentContext(harness.deps, {
        mcp: { read: () => okAsync({ servers: [] }) },
        brokerForUser,
      } as never);
      const result = await open(task, orb, { signal: opening.signal });
      expect(result.isOk()).toBe(true);
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
    const install = vi
      .spyOn(RemoteExecutionEnv.prototype, "installOwnerSkills")
      .mockReturnValue(okAsync(undefined));
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
      install.mockRestore();
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

  it("refreshes only the local native catalog before execution", async () => {
    const order: string[] = [];
    const tool = refreshProcessTools(
      {
        name: "codemode",
        description: "code",
        parameters: Type.Object({}),
        execute: async () => {
          order.push("execute");
          return {};
        },
      },
      () => {
        order.push("local refresh");
        return okAsync({} as never);
      },
    );
    await tool.execute({}, {} as never, BACKGROUND_CONTEXT);
    await tool.execute({}, {} as never, BACKGROUND_CONTEXT);
    expect(order).toEqual(["local refresh", "execute", "local refresh", "execute"]);
  });

  it("does not execute code when the native view cannot refresh", async () => {
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
    const discovery = admitProcessTools(
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

  it("rejects revoked admission and cleans both resources", async () => {
    const cleaned: string[] = [];
    const result = await admitProcessTools(
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

  it("rejects already-cancelled admission before registry installation", async () => {
    const cleaned: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await admitProcessTools(
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
    );
    expect(result.isErr() && result.error.code).toBe("cancelled");
    expect(cleaned).toEqual(["tools", "env"]);
  });

  it("preserves timezone with generic tool guidance", () => {
    const system = processAgentSystemContext("Asia/Tokyo");
    expect(system).toContain("User’s time zone: Asia/Tokyo");
    expect(system).toContain("Use codemode to compose tool calls.");
    expect(system).not.toMatch(/orb_spawn|subagent/i);
  });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("activates MCP without input and publishes healthy tools before held discovery joins close", async () => {
  const held = barrier(),
    release = barrier();
  let heldSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]!;
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    calls.push(`${name}:${message.method}`);
    if (name === "bad") return new Response("PRIVATE_PROVIDER_ERROR", { status: 503 });
    if (name === "held") {
      heldSignal = init.signal!;
      held.resolve();
      await release.promise;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name, version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "AUTO_PONG" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  const h = makeHarness();
  const orb = makeOrbRow("auto-mcp", "project", "running");
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(orb);
  const models = vi
    .spyOn(durableModels, "createDurableModels")
    .mockReturnValue(okAsync({ getModel: () => undefined } as never));
  const appendAlert = vi.fn<DurableAgent["appendAlert"]>(() =>
    okAsync({ recordId: "alert", duplicate: false }),
  );
  const opening = new AbortController();
  vi.stubEnv("PI_ORB_E2E_HISTORY_INSPECTION", "1");
  const task = new NoSimulationTask("automatic MCP", false);
  const logs = vi.spyOn(task, "log").mockImplementation(() => {});
  const open = createProcessAgentContext(h.deps, {
    mcp: {
      read: () =>
        okAsync({
          servers: ["bad", "datadog", "held"].map((name) => ({
            name,
            description: `Provider ${name}`,
            url: `https://${name}.test/mcp`,
            headers: {},
          })),
        }),
    },
  } as never);
  const options = (await open(task, orb, { signal: opening.signal }))._unsafeUnwrap();
  const tool = (name: string) =>
    options.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === name)!.tool;
  const section = options.registry
    .snapshot()
    .sections()
    .find(({ section }) => section.key === "mcp-status")!.section;
  try {
    expect(calls).toEqual([]);
    expect(tool("mcp_status").description).toContain(
      "MCP datadog: pending (mcp__datadog): Provider datadog",
    );
    options.activateResources!(appendAlert);
    opening.abort();
    await held.promise;
    expect(heldSignal?.aborted).toBe(false);
    expect(
      logs.mock.calls.some(
        ([line]) =>
          String(line) ===
          `lifecycle: orb=${orb.id} test_registry_published server=datadog status=available`,
      ),
    ).toBe(true);
    expect(appendAlert.mock.calls.map(([, message]) => message)).toEqual(["MCP bad: unavailable."]);
    const cached = await section.render({} as never, BACKGROUND_CONTEXT);
    expect(cached).toContain("MCP bad: unavailable.");
    expect(cached).toContain("MCP held: pending. Namespace: mcp__held.");
    expect(tool("mcp_status").description).toContain("MCP datadog: available");
    const result = await tool("mcp__datadog__ping").execute(
      {},
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("AUTO_PONG");
    expect(calls.filter((call) => call === "datadog:tools/list")).toHaveLength(1);
    const published = options.registry.snapshot();
    let closed = false;
    const closing = options.closeResources!().map(() => {
      closed = true;
      return undefined;
    });
    expect(heldSignal?.aborted).toBe(true);
    expect(closed).toBe(false);
    release.resolve();
    (await closing)._unsafeUnwrap();
    expect(options.registry.snapshot()).toBe(published);
    expect(await section.render({} as never, BACKGROUND_CONTEXT)).toBe(cached);
    expect(appendAlert).toHaveBeenCalledOnce();
    expect(calls).not.toContain("held:tools/list");
  } finally {
    release.resolve();
    await options.closeResources!();
    network.mockRestore();
    models.mockRestore();
    logs.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each([307, 308, 200])(
  "keeps project MCP secrets on the configured origin (%i)",
  async (status) => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    const destination: Array<{ method: string; key: string | null; rpc: string }> = [];
    const sourceKeys: Array<string | null> = [];
    dispatcher
      .get("https://unconfigured.test")
      .intercept({ path: "/capture", method: "POST" })
      .reply((request) => {
        destination.push({
          method: request.method,
          key: new Headers(request.headers).get("X-Api-Key"),
          rpc: JSON.parse(String(request.body)).method,
        });
        return { statusCode: 503, data: "PRIVATE_REDIRECT_BODY" };
      })
      .persist();
    const source = dispatcher.get("https://configured.test");
    source
      .intercept({ path: "/mcp", method: "POST" })
      .reply((request) => {
        sourceKeys.push(new Headers(request.headers).get("X-Api-Key"));
        if (status !== 200)
          return {
            statusCode: status,
            responseOptions: { headers: { location: "https://unconfigured.test/capture" } },
          };
        const message = JSON.parse(String(request.body));
        if (message.id === undefined) return { statusCode: 202 };
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
        return {
          statusCode: 200,
          data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    source.intercept({ path: "/mcp", method: "GET" }).reply(405).persist();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(((input, init) =>
        localFetch(input as string, { ...init, dispatcher } as never)) as typeof fetch);
    const models = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync({ getModel: () => undefined } as never));
    const h = makeHarness();
    const orb = makeOrbRow("redirect-mcp", "project", "running");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    const deps = {
      ...h.deps,
      projectSecrets: {
        ...h.deps.projectSecrets,
        pointers: new FakeProjectSecretPointerStore(orb.projectId),
      },
    };
    const task = new NoSimulationTask("MCP redirect isolation", false);
    const logs = vi.spyOn(task, "log").mockImplementation(() => {});
    const completed = barrier();
    const appendAlert = vi.fn<DurableAgent["appendAlert"]>(() => {
      completed.resolve();
      return okAsync({ recordId: "alert", duplicate: false });
    });
    try {
      (
        await putProjectSecret(
          task,
          deps.projectSecrets,
          orb.projectId,
          "MCP_KEY",
          "SYNTHETIC_PROJECT_KEY",
        )
      )._unsafeUnwrap();
      const open = createProcessAgentContext(deps, {
        mcp: {
          read: () =>
            okAsync({
              servers: [
                {
                  name: "fixture",
                  url: "https://configured.test/mcp",
                  headers: { "X-Api-Key": { secret: "MCP_KEY" } },
                },
              ],
            }),
        },
      } as never);
      const composed = (
        await open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      const unsubscribe = composed.registry.subscribe(() => {
        if (
          status === 200 &&
          composed.registry
            .snapshot()
            .tools()
            .some(({ tool }) => tool.name === "mcp__fixture__ping")
        )
          completed.resolve();
      });
      try {
        expect(composed.activateResources).toBeTypeOf("function");
        composed.activateResources?.(appendAlert);
        await completed.promise;
        expect(destination, "redirect destination must receive neither request nor secret").toEqual(
          [],
        );
        expect(sourceKeys.length).toBeGreaterThan(0);
        expect(sourceKeys.every((key) => key === "SYNTHETIC_PROJECT_KEY")).toBe(true);
        const visible = JSON.stringify(
          composed.registry
            .snapshot()
            .tools()
            .map(({ tool }) => tool.description),
        );
        if (status === 200) {
          expect(visible).toContain("MCP fixture: available");
          expect(appendAlert).not.toHaveBeenCalled();
        } else {
          expect(visible).toContain("MCP fixture: unavailable");
          expect(appendAlert.mock.calls.map(([, message]) => message)).toEqual([
            "MCP fixture: unavailable.",
          ]);
          expect(
            logs.mock.calls.filter(([line]) => String(line).includes("durable.mcp_unavailable")),
          ).toHaveLength(1);
        }
        expect(JSON.stringify([visible, logs.mock.calls, appendAlert.mock.calls])).not.toMatch(
          /SYNTHETIC_PROJECT_KEY|PRIVATE_REDIRECT_BODY/,
        );
      } finally {
        unsubscribe();
        await composed.closeResources?.();
      }
    } finally {
      logs.mockRestore();
      models.mockRestore();
      network.mockRestore();
      await dispatcher.close();
    }
  },
);
