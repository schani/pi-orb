import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RuntimeHealthSchema, type ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgent } from "./agent.ts";
import { DurableAgentPlane, durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const initialSettings = {
  model: { provider: "faux", id: "faux-1" },
  thinkingLevel: "off" as const,
};

function agentOptions() {
  const models = createModels();
  models.setProvider(
    fauxProvider({
      models: [
        { id: "faux-1", reasoning: true },
        { id: "faux-2", reasoning: true },
      ],
    }).provider,
  );
  return {
    models,
    registry: createRegistry(),
    env: new NodeExecutionEnv({ cwd: "/tmp" }),
    checkoutCommit: "commit",
    instructions: "instruction",
    initialSettings,
  };
}

describe("frozen process qualification regressions", () => {
  it.each([
    { type: "set_model", model: { provider: "faux", id: "faux-2" } },
    { type: "set_thinking", thinkingLevel: "high" },
  ] as const)(
    "acknowledges $type only after history commits and settings become writable",
    async (action) => {
      const entered = barrier();
      const release = barrier();
      let hold = false;
      let projected = false;
      const frames: ServerFrame[] = [];
      const agent = (
        await DurableAgent.open({
          ...agentOptions(),
          orbId: "orb",
          storage: new MemoryStorage(),
          commitHistory: () => {
            if (!hold) return okAsync(undefined);
            entered.resolve();
            return ResultAsync.fromPromise(release.promise, () =>
              durableError("fixture barrier"),
            ).map(() => {
              projected = true;
              return undefined;
            });
          },
        })
      )._unsafeUnwrap();
      agent.subscribe((frame) => frames.push(frame));
      try {
        hold = true;
        let acknowledged = false;
        let writableAtAck: boolean | undefined;
        let settingsAtAck: ServerFrame | undefined;
        const pending = agent.request("settings", action).map((result) => {
          acknowledged = true;
          writableAtAck = agent.snapshot()._unsafeUnwrap().settings?.writable;
          settingsAtAck = frames
            .filter(
              (frame) => frame.type === "runtime.event" && frame.event.type === "agent_settings",
            )
            .at(-1);
          return result;
        });
        await entered.promise;
        // Drain native commit callbacks while the explicit projection barrier stays closed.
        await setImmediate();
        expect(projected).toBe(false);
        expect.soft(acknowledged).toBe(false);
        release.resolve();
        expect((await pending)._unsafeUnwrap()).toEqual({
          type: "settings_applied",
          duplicate: false,
        });
        expect.soft(projected).toBe(true);
        expect.soft(writableAtAck).toBe(true);
        expect.soft(settingsAtAck).toMatchObject({
          type: "runtime.event",
          event: { type: "agent_settings", writable: true },
        });
        await agent.waitForIdle();
        const settingsFrames = frames.filter(
          (frame) => frame.type === "runtime.event" && frame.event.type === "agent_settings",
        );
        expect.soft(settingsFrames.at(-1)).toMatchObject({
          type: "runtime.event",
          event: { type: "agent_settings", writable: true },
        });
        expect.soft(agent.snapshot()._unsafeUnwrap().settings?.writable).toBe(true);
        expect((await agent.request("settings", action))._unsafeUnwrap()).toEqual({
          type: "settings_applied",
          duplicate: true,
        });
      } finally {
        release.resolve();
        await agent.close();
      }
    },
  );

  it("rejects the settings ACK and exposes projection failure durably and publicly", async () => {
    const failure = durableError("settings projection unavailable", true);
    let fail = false;
    const edges: string[] = [];
    const frames: ServerFrame[] = [];
    const agent = (
      await DurableAgent.open({
        ...agentOptions(),
        orbId: "orb",
        storage: new MemoryStorage(),
        commitHistory: () => (fail ? errAsync(failure) : okAsync(undefined)),
        edge: (code) => {
          edges.push(code);
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    agent.subscribe((frame) => frames.push(frame));
    try {
      fail = true;
      const result = await agent.request("settings", {
        type: "set_thinking",
        thinkingLevel: "high",
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBe(failure);
      expect(agent.health().status).toBe("failed");
      expect(edges).toContain("history.projection_failed");
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "server.error",
          error: expect.objectContaining({ code: "history_unavailable" }),
        }),
      );
    } finally {
      await agent.close();
    }
  });

  it.each([
    { code: "e2e_launch_failure", retryable: false },
    { code: "e2e_launch_failure", retryable: true },
    { code: "clone_failed", retryable: true },
  ])(
    "reports structured $code with retryable=$retryable and permits explicit replacement",
    async ({ code, retryable }) => {
      const directory = await mkdtemp(join(tmpdir(), "durable-qualified-health-"));
      const initializationError = {
        code,
        message: code === "clone_failed" ? "git checkout failed" : "test launch failure injected",
        retryable,
      };
      const failedHealth = {
        v: 1 as const,
        orbId: "orb",
        runtimeInstanceId: "agent:orb",
        status: "failed" as const,
        error: initializationError,
      };
      expect(Check(RuntimeHealthSchema, failedHealth)).toBe(true);
      let attempts = 0;
      const plane = (
        await DurableAgentPlane.create({
          persistence: new MemoryAgentPersistence(),
          openContext: () => {
            attempts++;
            return attempts === 1
              ? errAsync({
                  type: "runtime_client_error" as const,
                  code: "initialization_failed" as const,
                  answered: true,
                  message: initializationError.message,
                  retryable,
                  initializationError,
                })
              : okAsync(agentOptions());
          },
        })
      )._unsafeUnwrap();
      const task = new NoSimulationTask("qualified-health", false);
      const context = { signal: new AbortController().signal };
      const orb = makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 });
      try {
        const result = await plane.health(task, orb, context);
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toEqual(failedHealth);
        expect(plane.session("orb")).toBeNull();
        await plane.suspend(task, "orb", context);
        const ready = (
          await plane.health(task, { ...orb, hostIncarnation: 2 }, context)
        )._unsafeUnwrap();
        expect(ready.status).toBe("ready");
        expect(attempts).toBe(2);
      } finally {
        await plane.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { code: "unreachable", answered: false, retryable: true },
    { code: "http_error", answered: true, retryable: true },
    { code: "invalid_response", answered: true, retryable: false },
    { code: "initialization_failed", answered: true, retryable: true },
  ] as const)("preserves unproven $code as Err", async (detail) => {
    const directory = await mkdtemp(join(tmpdir(), "durable-unproven-health-"));
    const failure: RuntimeClientError = {
      type: "runtime_client_error",
      message: "not ready",
      ...detail,
    };
    const plane = (
      await DurableAgentPlane.create({
        persistence: new MemoryAgentPersistence(),
        openContext: () => errAsync(failure),
      })
    )._unsafeUnwrap();
    try {
      const result = await plane.health(
        new NoSimulationTask("unproven-health", false),
        makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 }),
        { signal: new AbortController().signal },
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBe(failure);
    } finally {
      await plane.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
