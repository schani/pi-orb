import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { GenerationTask } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";

it.each([false, true])("Native trailing partial commit: completion held=%s", async (held) => {
  const phase = GenerationTask.definition.phases.request;
  const message = fauxAssistantMessage([{ type: "thinking", thinking: "STREAMED_REASONING" }]);
  const events = createAssistantMessageEventStream();
  const partials: unknown[] = [];
  const final = Symbol("classified");
  const live: { generation?: { message?: unknown } } = {};
  const timers: (() => void)[] = [];
  let scheduled!: () => void;
  const timerScheduled = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  let committed!: () => void;
  const partialCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let classified: unknown;
  const runtime = {
    setTimer: (callback: () => void, delay: number) => {
      expect(delay).toBe(100);
      let cancelled = false;
      timers.push(() => {
        if (!cancelled) callback();
      });
      scheduled();
      return () => {
        cancelled = true;
      };
    },
    conversationId: "conversation",
    signal: new AbortController().signal,
    models: { getModel: () => ({}), streamSimple: () => events },
    settings: { progress: { partialIntervalMs: 100 } },
    snapshot: async () => ({ sessionId: "provider-session" }),
    context: async () => ({ messages: [] }),
    hooks: {
      each: async (name: string, invoke: (hook: (message: unknown) => void) => Promise<void>) => {
        if (name === "afterResponse") {
          await invoke((message) => {
            classified = message;
          });
          throw final;
        }
      },
    },
    commit: async (apply: (tx: unknown) => Promise<unknown>) => {
      await apply({ doc: async () => live });
      if (live.generation?.message) {
        partials.push(live.generation.message);
        committed();
      }
    },
  };
  events.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "STREAMED_REASONING",
    partial: message,
  });
  const request = phase(
    {
      state: {
        checkpoint: {
          attempt: 1,
          model: { provider: "faux", modelId: "faux-1" },
          cutoff: "input",
        },
      },
    } as Parameters<typeof phase>[0],
    runtime as unknown as Parameters<typeof phase>[1],
    {} as Parameters<typeof phase>[2],
  );
  const classifiedRequest = expect(request).rejects.toBe(final);
  if (held) {
    await timerScheduled;
    const flush = timers[0];
    if (!flush) throw new Error("Native partial timer was not scheduled");
    flush();
    await partialCommitted;
  }
  events.push({ type: "done", reason: "stop", message });
  events.end();
  await classifiedRequest;
  expect(timers).toHaveLength(1);
  expect(partials).toHaveLength(held ? 1 : 0);
  expect(classified).toEqual(message);
});
