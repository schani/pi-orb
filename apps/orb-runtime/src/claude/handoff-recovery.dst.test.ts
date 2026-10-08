import { join } from "node:path";
import type { JsonObject } from "@pi-orb/protocol";
import { err, Result } from "neverthrow";
import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  childEdge,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";
import { qualifyClaudeRestart, reconcileClaudeHandoffs } from "./restore.ts";

it.each(["terminal", "disposition"] as const)(
  "reopens the exact %s crash cut on the same compute",
  async (cut) => {
    await runDst({ name: `claude-handoff-reopen-${cut}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "native-and-restore",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              await f.query.emit(task, childEdge("task_started"));
              await f.query.emit(task, childEdge("task_notification"));
              await f.query.emit(task, rootResult);
              await f.query.emit(task, {
                ...rootResult,
                uuid: "33333333-3333-4333-8333-333333333333",
              });
              expect(f.journal().pendingHandoffs?.child).toBeDefined();
              expect(f.journal().handoffTerminals?.child).toBeDefined();
              await task.checkpoint(
                "terminal proof durably persisted before simulated runtime loss",
              );
              f.failSync = true;
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              expect(f.agent.getHealth()).toMatchObject({
                status: "failed",
                error: { code: "history_unavailable" },
              });
              const journal = f.journal();
              const history = new ClaudeHistory(
                join(f.dir, "claude"),
                journal.id,
                journal.timestamp,
              );
              expect(history.scan(f.nativePath).isOk()).toBe(true);
              const publish = (id: string, overflow: JsonObject) =>
                history
                  .appendPlatform({
                    id,
                    parentId: history.view.at(-1)?.id ?? null,
                    timestamp: f.state.timestamp,
                    type: "event",
                    eventType: "claude.handoff_interrupted",
                    custom: { customType: "claude.handoff_interrupted", display: true },
                    overflow,
                  })
                  .andThen(() => history.scan(f.nativePath).map(() => undefined));
              if (cut === "disposition") {
                expect(
                  reconcileClaudeHandoffs(
                    journal,
                    history.view,
                    journal.guardLifetime!,
                    publish,
                    () => err({ message: "injected crash before sidecar commit" }),
                  )._unsafeUnwrapErr().stage,
                ).toBe("persistence");
              }
              await task.checkpoint("reopen after the selected durable crash frontier");
              const reopened = f.journal();
              const reopenedHistory = new ClaudeHistory(
                join(f.dir, "claude"),
                reopened.id,
                reopened.timestamp,
              );
              expect(reopenedHistory.scan(f.nativePath).isOk()).toBe(true);
              let duplicates = 0;
              const restored = reconcileClaudeHandoffs(
                reopened,
                reopenedHistory.view,
                reopened.guardLifetime!,
                (id, overflow) => {
                  duplicates++;
                  return reopenedHistory
                    .appendPlatform({
                      id,
                      parentId: reopenedHistory.view.at(-1)?.id ?? null,
                      timestamp: f.state.timestamp,
                      type: "event",
                      eventType: "claude.handoff_interrupted",
                      custom: { customType: "claude.handoff_interrupted", display: true },
                      overflow,
                    })
                    .andThen(() => reopenedHistory.scan(f.nativePath).map(() => undefined));
                },
                Result.fromThrowable(
                  () =>
                    nativeHistoryFiles.commit(
                      join(f.dir, "claude", "session.json"),
                      JSON.stringify(reopened),
                    ),
                  () => ({ message: "sidecar persistence failed" }),
                ),
              );
              expect(restored._unsafeUnwrap()).toEqual(["child"]);
              expect(duplicates).toBe(cut === "disposition" ? 0 : 1);
              await task.checkpoint(
                "reopen verifies fsynced disposition and released exact handoff",
              );
              const final = f.journal();
              const finalHistory = new ClaudeHistory(
                join(f.dir, "claude"),
                final.id,
                final.timestamp,
              );
              expect(finalHistory.scan(f.nativePath).isOk()).toBe(true);
              expect(final.pendingHandoffs).toEqual({});
              expect(final.handoffTerminals).toEqual({});
              expect(
                finalHistory.view.filter(
                  (record) =>
                    record.type === "event" && record.eventType === "claude.handoff_interrupted",
                ),
              ).toHaveLength(1);
              expect(
                qualifyClaudeRestart(final, finalHistory.view, final.guardLifetime!).isOk(),
              ).toBe(true);
              expect(f.queries).toHaveLength(2);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    });
  },
);
