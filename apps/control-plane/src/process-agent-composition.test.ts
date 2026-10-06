import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { DurableAgent } from "./adapters/durable/agent.ts";
import { durableError } from "./adapters/durable/manager.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { RemoteExecutionEnv } from "./adapters/execution-client/env.ts";
import {
  closeProcessAgentResources,
  discoverProcessTools,
  processAgentContext,
  processAgentSystemContext,
  createProcessAgentContext as productionCreateProcessAgentContext,
  refreshProcessMcpTool,
  scopedMcpAuth,
  scopedMcpHeaders,
  snapshotSkills,
} from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "./testkit/fixtures.ts";

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
        beginDrain: () => okAsync(undefined),
        release: () => okAsync(undefined),
        artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
      },
    );
}

describe("process agent composition", () => {
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
        expect(result.value.instructions).toContain("Required repository resources are loaded");
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

  it("hydrates authoritative resources before publishing ready compute", async () => {
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
        instructions: [{ path: "/repo/AGENTS.md", content: "PRIVATE HOST INSTRUCTIONS" }],
        skills: [],
        resources: [],
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
      expect((await result.value.hydrateExecution?.(BACKGROUND_CONTEXT))?.isOk()).toBe(true);
      expect(result.value.prompt?.("root")).toContain("PRIVATE HOST INSTRUCTIONS");
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

  it("projects skill metadata without placing bodies in the prompt", () => {
    const skills = snapshotSkills([
      {
        path: "/repo/.agents/skills/demo/SKILL.md",
        content: "---\nname: demo\ndescription: Inspect the demo\n---\nSecret body not in system",
      },
    ]);
    expect(skills[0]).toMatchObject({
      name: "demo",
      description: "Inspect the demo",
      filePath: "/repo/.agents/skills/demo/SKILL.md",
    });
    expect(JSON.stringify(skills)).not.toContain("Secret body");
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

  it("persists sanitized MCP status edges in code-mode tool diagnostics before execution", async () => {
    const diagnostics: unknown[] = [];
    const order: string[] = [];
    const original = {
      name: "codemode",
      description: "code",
      parameters: {},
      execute: async () => {
        order.push("execute");
        return {};
      },
    };
    const tool = refreshProcessMcpTool(original as never, () => {
      order.push("discover");
      return okAsync([
        { name: "fixture", status: "needs-auth", error: { code: "forbidden", message: "secret" } },
      ] as const);
    });
    const api = { diagnostic: (value: unknown) => diagnostics.push(value) };
    await tool.execute({}, api as never, BACKGROUND_CONTEXT);
    await tool.execute({}, api as never, BACKGROUND_CONTEXT);
    expect(order).toEqual(["discover", "execute", "discover", "execute"]);
    expect(diagnostics).toEqual([
      { severity: "info", code: "mcp_status", message: "MCP fixture: needs-auth." },
    ]);
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

  it("rejects discovery aborted before registry installation and cleans both resources", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleaned: string[] = [];
    const discovery = discoverProcessTools(
      {
        ready: () => ResultAsync.fromSafePromise(admission).map(() => []),
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
    controller.abort();
    release?.();
    const result = await discovery;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("cancelled");
    expect(cleaned).toEqual(["tools", "env"]);
  });

  it("rejects revoked admission after successful discovery and cleans both resources", async () => {
    const cleaned: string[] = [];
    const result = await discoverProcessTools(
      {
        ready: () => okAsync([]),
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

  it("rejects tool discovery errors rather than installing an empty registry", async () => {
    const cleaned: string[] = [];
    const result = await discoverProcessTools(
      {
        ready: () => errAsync({ code: "unavailable" as const, message: "discovery failed" }),
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
    );
    expect(result.isErr()).toBe(true);
    expect(cleaned).toEqual(["tools", "env"]);
  });

  it("preserves timezone and APPEND_SYSTEM context with generic tool guidance", () => {
    const system = processAgentSystemContext("Asia/Tokyo", [
      { path: "/repo/.pi/APPEND_SYSTEM.md", content: "Repository environment context" },
      { path: "/repo/.pi/SYSTEM.md", content: "Do not inject this resource" },
    ]);
    expect(system).toContain("User’s time zone: Asia/Tokyo");
    expect(system).toContain("Repository environment context");
    expect(system).toContain("orb_self");
    expect(system).not.toContain("Do not inject this resource");
    expect(system).not.toContain("profiles");
  });
});
