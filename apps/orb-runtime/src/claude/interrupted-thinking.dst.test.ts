import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each([false, true])(
  "schedules interrupted thinking publication, scans and close (orphan=%s)",
  async (orphan) => {
    await runDst(
      { name: `claude-interrupted-thinking-orphan-${orphan}`, iterations: 40 },
      async (sim) => {
        let consumer: SimulationTask | null = null;
        let armed = false;
        let ready: () => void = () => undefined;
        const consumerReady = new Promise<void>((resolve) => {
          ready = resolve;
        });
        let resultQueued = false;
        let produced = false;
        const f = new ComposedClaudeFixture(Promise.resolve(), {
          yieldMessage: async () => {
            if (armed) await consumer?.checkpoint("SDK consume before query identity fence");
          },
        });
        try {
          expect((await f.attach()).isOk()).toBe(true);
          expect((await f.agent.submitMessage([{ type: "text", text: "boot" }], "op")).isOk()).toBe(
            true,
          );
          const input = await f.query.input.next();
          if (input.done) throw new Error("missing input");
          f.receipt(input.value);
          const query = f.query;
          const message = (value: object) =>
            ({
              session_id: f.state.id,
              parent_tool_use_id: null,
              ...value,
            }) as SDKMessage;
          const stream = (event: object, rest: object = {}) =>
            message({
              type: "stream_event",
              uuid: "stream",
              event,
              ...rest,
            });
          const result = await sim.runTasks([
            {
              name: "sdk-consumer",
              f: async (task) => {
                consumer = task;
                armed = true;
                ready();
                await f.agent.waitForStream();
              },
            },
            {
              name: "native-output",
              f: async (task) => {
                await consumerReady;
                if (orphan)
                  await query.emit(
                    task,
                    stream(
                      {
                        type: "content_block_start",
                        index: 9,
                        content_block: { type: "thinking", thinking: "old", signature: "" },
                      },
                      { uuid: "orphan" },
                    ),
                  );
                await query.emit(
                  task,
                  stream(
                    {
                      type: "message_start",
                      message: { id: "current-api-id" },
                    },
                    { user_message_uuid: input.value.uuid },
                  ),
                );
                await query.emit(
                  task,
                  stream(
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "thinking", thinking: "current", signature: "" },
                    },
                    { uuid: "current" },
                  ),
                );
                await query.emit(task, stream({ type: "content_block_stop", index: 0 }));
                await query.emit(task, stream({ type: "message_stop" }));
                await task.checkpoint("native successor journal runs ahead of result consumption");
                f.append({
                  type: "assistant",
                  uuid: "successor",
                  message: {
                    id: "successor-api-id",
                    role: "assistant",
                    content: [{ type: "text", text: "later" }],
                  },
                });
                const consumed = query.enqueue(
                  message({
                    type: "result",
                    uuid: "aborted",
                    subtype: "error_during_execution",
                    is_error: true,
                    terminal_reason: "aborted_streaming",
                    user_message_uuid: input.value.uuid,
                    num_turns: 1,
                    queued_turn_count: 0,
                    errors: ["interrupted"],
                  }),
                );
                resultQueued = true;
                await consumed;
                produced = true;
              },
            },
            {
              name: "history-reader",
              f: async (task) => {
                await consumerReady;
                while (!produced) {
                  await task.checkpoint("snapshot scan races stream stops and error append");
                  const snapshot = f.agent.snapshot();
                  if (snapshot.isErr()) {
                    expect(orphan).toBe(true);
                    expect(f.agent.getHealth()).toMatchObject({
                      status: "failed",
                      error: { code: "claude_stream_identity_gap" },
                    });
                  }
                }
              },
            },
            {
              name: "close",
              f: async (task) => {
                while (!resultQueued)
                  await task.checkpoint("wait for queued native terminal result");
                await task.checkpoint("close races yielded result consumer");
                const closing = f.agent.closeExtensions();
                query.exit();
                await task.checkpoint("exit precedes independent stdout EOF");
                query.endOutput();
                await closing;
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          const retired = f.frames.filter(
            (frame) => frame.type === "history.record" && frame.retiredBlockIds.length > 0,
          );
          if (orphan) {
            const retiredIds = retired.flatMap((frame) =>
              frame.type === "history.record" ? frame.retiredBlockIds : [],
            );
            expect(retiredIds.every((id) => id === "current:0")).toBe(true);
            expect(retiredIds.length).toBeLessThanOrEqual(1);
            expect(f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(
              retiredIds.length === 0 ? ["orphan:9", "current:0"] : ["orphan:9"],
            );
          } else {
            expect(retired).toHaveLength(1);
            expect(retired[0]).toMatchObject({
              record: { type: "event", eventType: "claude.result_error" },
              retiredBlockIds: ["current:0"],
            });
            expect(f.agent.liveView()?.blocks ?? []).toEqual([]);
          }
          for (const frame of retired) {
            if (frame.type !== "history.record") throw new Error("unexpected frame");
            expect(
              f.history.view.some(
                (record) =>
                  record.id === frame.record.id &&
                  record.type === "event" &&
                  record.eventType === "claude.result_error",
              ),
            ).toBe(true);
          }
        } finally {
          armed = false;
          consumer = null;
          f.query.exit();
          f.query.endOutput();
          await f.agent.closeExtensions();
          f.dispose();
        }
      },
    );
  },
);

it.each([
  ["error", false],
  ["error", true],
  ["steering", false],
  ["steering", true],
] as const)("binds %s retirement with native journal lag (late=%s)", async (kind, late) => {
  await runDst(
    { name: `claude-interrupted-thinking-${kind}-late-${late}`, iterations: 40 },
    async (sim) => {
      let consumer: SimulationTask | null = null;
      let armed = false;
      let firstEventId: string | undefined;
      let resultProcessed = false;
      let written = false;
      let done = false;
      const eventType = kind === "error" ? "claude.result_error" : "claude.steering_result";
      const f = new ComposedClaudeFixture(Promise.resolve(), {
        yieldMessage: async () => {
          if (armed)
            await consumer?.checkpoint(
              "consume genuine turn boundary before retirement publication",
            );
        },
      });
      f.agent.subscribe((frame) => {
        if (
          frame.type === "history.record" &&
          frame.record.type === "event" &&
          frame.record.eventType === eventType &&
          firstEventId === undefined
        ) {
          firstEventId = frame.record.id;
          if (late) expect(frame.retiredBlockIds).toEqual([]);
        }
      });
      try {
        expect((await f.attach()).isOk()).toBe(true);
        expect(
          (await f.agent.submitMessage([{ type: "text", text: "initial" }], "op")).isOk(),
        ).toBe(true);
        const initial = await f.query.input.next();
        if (initial.done) throw new Error("missing initial input");
        expect(
          (
            await f.agent.deliverInboxMessage("steer", ["steer"], [{ type: "text", text: "steer" }])
          ).isOk(),
        ).toBe(true);
        const steer = await f.query.input.next();
        if (steer.done) throw new Error("missing steering input");
        const query = f.query;
        const message = (value: object) =>
          ({ session_id: f.state.id, parent_tool_use_id: null, ...value }) as SDKMessage;
        const stream = (event: object, rest: object = {}) =>
          message({ type: "stream_event", uuid: "stream", event, ...rest });
        const tool = { type: "tool_use", id: "tool", name: "fixed", input: {} };
        const write = () => {
          f.receipt(initial.value);
          f.append({
            type: "assistant",
            uuid: "prior-owner",
            message: {
              role: "assistant",
              id: "prior-api",
              content: [tool],
            },
          });
          f.receipt(steer.value);
          written = true;
        };
        if (!late) write();
        const result = await sim.runTasks([
          {
            name: "consumer",
            f: async (task) => {
              consumer = task;
              armed = true;
              await f.agent.waitForStream();
            },
          },
          {
            name: "native-stream",
            f: async (task) => {
              while (consumer === null)
                await task.checkpoint("wait for controlled consume boundary");
              await query.emit(
                task,
                stream(
                  { type: "message_start", message: { id: "prior-api" } },
                  { user_message_uuid: initial.value.uuid },
                ),
              );
              await query.emit(
                task,
                stream({ type: "content_block_start", index: 0, content_block: tool }),
              );
              await query.emit(
                task,
                message({
                  type: "assistant",
                  uuid: "prior-owner",
                  message: { role: "assistant", id: "prior-api", content: [tool] },
                }),
              );
              await query.emit(task, stream({ type: "content_block_stop", index: 0 }));
              await query.emit(task, stream({ type: "message_stop" }));
              await query.emit(
                task,
                stream({ type: "message_start", message: { id: "thinking-api" } }),
              );
              await query.emit(
                task,
                stream(
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "partial", signature: "" },
                  },
                  { uuid: "thinking" },
                ),
              );
              await query.emit(task, stream({ type: "content_block_stop", index: 0 }));
              await query.emit(task, stream({ type: "message_stop" }));
              await query.emit(
                task,
                message({
                  type: "result",
                  uuid: "interrupted-result",
                  subtype: kind === "error" ? "error_during_execution" : "success",
                  is_error: kind === "error",
                  terminal_reason: "aborted_streaming",
                  user_message_uuid: initial.value.uuid,
                  num_turns: 1,
                  queued_turn_count: 1,
                  errors: kind === "error" ? ["interrupted"] : undefined,
                }),
              );
              resultProcessed = true;
              while (!written) await task.checkpoint("native input journal may lag public result");
              await query.emit(
                task,
                message({
                  type: "result",
                  uuid: "human-result",
                  subtype: "success",
                  is_error: false,
                  user_message_uuid: steer.value.uuid,
                  num_turns: 1,
                  queued_turn_count: 0,
                }),
              );
            },
          },
          {
            name: "journal-and-snapshots",
            f: async (task) => {
              while (!resultProcessed) {
                await task.checkpoint("scan before or after stopped response/result processing");
                expect(f.agent.snapshot().isOk()).toBe(true);
              }
              if (late) {
                expect(firstEventId).toBeDefined();
                expect(f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual([
                  "thinking:0",
                ]);
                await task.checkpoint("journal becomes durable after existing event publication");
                write();
              }
              while (!done) {
                await task.checkpoint("authoritative scan races native exit/fsync and close");
                expect(f.agent.snapshot().isOk()).toBe(true);
              }
            },
          },
          {
            name: "terminal-exit",
            f: async (task) => {
              while (!query.closeRequested)
                await task.checkpoint("wait for terminal result to start graceful close");
              await task.checkpoint("owned native process exit after late journal write");
              query.exit();
              await task.checkpoint("stdout EOF follows process exit independently");
              query.endOutput();
              await f.agent.closeExtensions();
              done = true;
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const published = f.frames.filter(
          (frame) => frame.type === "history.record" && frame.record.id === firstEventId,
        );
        expect(published).toHaveLength(late ? 2 : 1);
        expect(published.at(-1)).toMatchObject({ retiredBlockIds: ["thinking:0"] });
        expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
        expect(f.agent.liveView()).toBeNull();
      } finally {
        armed = false;
        consumer = null;
        f.query.exit();
        f.query.endOutput();
        await f.agent.closeExtensions();
        f.dispose();
      }
    },
  );
});
