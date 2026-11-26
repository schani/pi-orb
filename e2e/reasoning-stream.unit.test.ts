import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])("Native trailing partial commit: completion held=%s", async (held) => {
  const message = fauxAssistantMessage([{ type: "thinking", thinking: "STREAMED_REASONING" }]);
  const events = createAssistantMessageEventStream();
  const models = createModels();
  models.setProvider({ ...fauxProvider().provider, streamSimple: () => events });

  const interval = 137;
  const timer = barrier<() => void>();
  let partialTimers = 0;
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry: createRegistry(),
      settings: { progress: { partialIntervalMs: interval } },
      setTimer(callback, delay) {
        if (delay !== interval) {
          const id = setTimeout(callback, delay);
          return () => clearTimeout(id);
        }
        partialTimers++;
        let cancelled = false;
        timer.resolve(() => {
          if (!cancelled) callback();
        });
        return () => {
          cancelled = true;
        };
      },
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const partials: unknown[] = [];
    const committed = barrier<void>();
    const observation = await harness.observeConversation(
      root.id,
      {
        advance(call) {
          if (call.kind !== "value") return;
          const live = call.value.docs[LiveDoc.definition.kind];
          const partial = (live?.generation as { message?: unknown } | undefined)?.message;
          if (partial !== undefined) {
            partials.push(partial);
            committed.resolve();
          }
        },
        end() {},
      },
      context,
    );
    harness.resume();
    const submission = await root.submit({ type: "input", content: "question" }, context);
    events.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "STREAMED_REASONING",
      partial: message,
    });
    const flush = await timer.promise;
    if (held) {
      flush();
      await committed.promise;
    }
    events.push({ type: "done", reason: "stop", message });
    events.end();
    await submission.wait(context);
    await root.waitForIdle(context);
    if (!held) flush();
    expect(partialTimers).toBe(1);
    expect(partials).toHaveLength(held ? 1 : 0);
    if (held) expect(partials[0]).toMatchObject({ content: message.content });
    expect((await harness.snapshot(LiveDoc, root.id, context))?.generation).toBeUndefined();
    const transcript = await root.context(context);
    expect(transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: message.content,
      stopReason: "stop",
    });
    observation.detach();
  } finally {
    events.end();
    await harness.close(context);
  }
});
