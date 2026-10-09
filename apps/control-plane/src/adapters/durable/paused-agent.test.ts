import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("a read-only reopen preserves unfinished work without advertising or dispatching it", async () => {
  const path = await mkdtemp(join(tmpdir(), "durable-paused-agent-"));
  let effects = 0;
  const pending = defineTask<null, { phase: "run" }, null>({
    name: "paused-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        effects++;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = () => {
    const value = createRegistry();
    value.install({ name: "paused-work", tasks: [pending] });
    return value;
  };
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
  const seed = await Harness.open(
    storage,
    { models: createModels(), registry: registry() },
    BACKGROUND_CONTEXT,
  );
  const root = await seed.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "openai-codex", modelId: "gpt-6.1" } },
  });
  await root.commit(
    (tx) => tx.createTask(pending, null, { ownership: { kind: "conversation" } }),
    BACKGROUND_CONTEXT,
  );
  await seed.close(BACKGROUND_CONTEXT);
  await authority.close();
  const reopened = authority;
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: (await reopened.openOrb("orb", true))._unsafeUnwrap().storage,
      models: createModels(),
      registry: registry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      instructions: "CP; pending",
      checkoutCommit: null,
      resume: false,
    })
  )._unsafeUnwrap();
  try {
    expect(effects).toBe(0);
    expect(agent.workActive()).toBe(false);
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect(agent.liveView()).toBeNull();
    expect(agent.snapshot()._unsafeUnwrap().settings?.writable).toBe(false);
    expect((await agent.prepareIdleStop())._unsafeUnwrap().prepared).toBe(true);
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
    // A stale health read cannot activate this read-only ownership scope.
    agent.resume();
    expect(agent.workActive()).toBe(false);
    expect(effects).toBe(0);
    await agent.close();
    const active = (
      await DurableAgent.open({
        orbId: "orb",
        storage: (await reopened.openOrb("orb", true))._unsafeUnwrap().storage,
        models: createModels(),
        registry: registry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        instructions: "CP",
        checkoutCommit: null,
      })
    )._unsafeUnwrap();
    try {
      await active.waitForIdle();
      expect(effects).toBe(1);
    } finally {
      await active.close();
    }
  } finally {
    await agent.close();
    await reopened.close();
    await rm(path, { recursive: true, force: true });
  }
});
