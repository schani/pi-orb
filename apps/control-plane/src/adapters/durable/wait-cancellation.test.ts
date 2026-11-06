import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { deferred } from "./tools/testkit/subagent-wait.ts";

const context = BACKGROUND_CONTEXT;

class HeldStorage extends MemoryStorage {
  hold: Promise<void> | undefined;
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    await this.hold;
    return super.commit(...args);
  }
}

// docs/postmortems/2026-11-06-control-plane-blackouts.md
it("a task wait cancelled behind an in-flight commit rejects only its caller", async () => {
  const child = deferred();
  const task = defineTask<null, { phase: "run" }, null>({
    name: "wait-cancellation-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        await child.promise;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = createRegistry();
  registry.install({ name: "wait-cancellation-child", tasks: [task] });
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const storage = new HeldStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const commit = deferred();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const id = await root.commit(
      (tx) => tx.createTask(task, null, { ownership: { kind: "conversation" }, background: true }),
      context,
    );
    storage.hold = commit.promise;
    const inFlight = root.commit(
      (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
      context,
    );
    const local = withCancel(context);
    const waiting = harness.waitForTask(id, local.context);
    const outcome = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    local.cancel();

    // Node reports unhandled rejections between macrotasks.
    await new Promise(setImmediate);
    expect(unhandled).toEqual([]);

    commit.resolve();
    await inFlight;
    await outcome;
  } finally {
    process.off("unhandledRejection", onUnhandled);
    commit.resolve();
    child.resolve();
    await harness.close(context);
  }
});
