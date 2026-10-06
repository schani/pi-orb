import { ok } from "neverthrow";
import { expect, it } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  childHook,
  nativeHook,
  nativeHookResponse,
  rootResult,
  ScheduledClaudeQuery,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { ClaudeHistory } from "./history.ts";
import { qualifyClaudeRestart } from "./restore.ts";

it("native child hooks, independent inventories, process exit, stdout and final history all retain ownership", async () => {
  await runDst({ name: "claude-composed-native-drain", iterations: 30 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const result = await sim.runTasks([
        {
          name: "native-driver",
          f: async (task) => {
            const input = await submitReceipt(task, f);
            expect(f.journal().deliveries["inbox"]?.uuid).toBe(input.uuid);
            expect(f.query.options.model).toBe("opus");
            await childHook(task, f);
            f.childFile();
            await f.query.emit(task, background([]));
            await f.query.emit(task, rootResult);
            expect(f.agent.gateView().activity).toBe("busy");
            expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
            expect(f.query.closeRequested).toBe(false);
            await f.query.emit(task, childEdge("task_notification"));
            expect(f.agent.gateView().activity).toBe("busy");
            expect(f.query.closeRequested).toBe(false);
            await f.query.emit(
              task,
              background([{ task_id: "inventory-task", description: "inventory-only work" }]),
            );
            await f.query.emit(task, rootResult);
            expect(f.query.closeRequested).toBe(false);
            expect(f.state.ownedBackgroundTasks).toEqual({
              "inventory-task": "inventory-only work",
            });
            await f.query.emit(task, background([]));
            expect(f.query.closeRequested).toBe(true);
            await task.checkpoint("native exited but trailing stdout still open");
            f.query.exit();
            expect(f.agent.gateView().activity).toBe("busy");
            expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
            await task.checkpoint("late native root append after process exit");
            f.append({
              type: "assistant",
              uuid: "final-root",
              message: { content: "final root", model: "claude-opus" },
            });
            f.query.endOutput();
            await f.agent.closeExtensions();
            await task.checkpoint("operation terminal persisted after close drain");
            expect(f.agent.gateView().activity).toBe("idle");
            const snapshot = f.agent.replicationSnapshot()._unsafeUnwrap();
            expect(snapshot.records.some((record) => record.id === "private-child")).toBe(false);
            expect(snapshot.records.find((record) => record.id === input.uuid)).toMatchObject({
              inboxMessageIds: ["inbox"],
            });
            expect(snapshot.records.find((record) => record.id === "final-root")).toMatchObject({
              model: { provider: "anthropic", id: "claude-opus" },
            });
            const terminal = snapshot.records.find(
              (record) =>
                record.type === "event" && record.eventType === "claude.operation_finished",
            );
            expect(terminal).toBeDefined();
            expect(
              snapshot.records.findIndex((record) => record.id === terminal?.id),
            ).toBeGreaterThan(snapshot.records.findIndex((record) => record.id === "final-root"));
            expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
            expect(
              (await f.agent.submitMessage([{ type: "text", text: "late" }], "late")).isErr(),
            ).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    } finally {
      f.dispose();
    }
  });
});

it.each(["paired", "unmatched"] as const)(
  "%s native hook drain composed DST preserves receipts across independent exit and EOF",
  async (kind) => {
    await runDst({ name: `claude-native-hook-drain-${kind}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        let rotating = false;
        let hooksConsumed = false;
        const result = await sim.runTasks([
          {
            name: "operation-owner",
            f: async (task) => {
              const input = await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              expect(f.query.closeRequested).toBe(true);
              rotating = true;
              await f.agent.closeExtensions();
              await task.checkpoint("final native hook drain outcome and receipt provenance");
              expect(f.history.view.find((record) => record.id === input.uuid)).toMatchObject({
                inboxMessageIds: ["inbox"],
              });
              expect(f.history.view.some((record) => record.id === "final-native-root")).toBe(true);
              const terminal = f.history.view.find(
                (record) =>
                  record.type === "event" && record.eventType === "claude.operation_finished",
              );
              if (kind === "paired") {
                expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
                expect(terminal).toMatchObject({ overflow: { outcome: "completed" } });
              } else {
                expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
                expect(f.agent.gateView()).toMatchObject({
                  acceptingWork: false,
                  activity: "busy",
                });
                expect(f.agent.prepareIdleStop().isErr()).toBe(true);
                expect(terminal).toBeUndefined();
                expect(
                  f.history.view.find(
                    (record) =>
                      record.type === "event" && record.eventType === "claude.rotation_failed",
                  ),
                ).toMatchObject({
                  custom: { display: true },
                  overflow: { reason: "owned_work", pendingHooks: 1 },
                });
                expect(
                  qualifyClaudeRestart(f.journal(), f.history.view, "new-compute")._unsafeUnwrap()
                    .interruptedOperations,
                ).toEqual([f.journal().deliveries["inbox"]?.operationId]);
              }
              expect(f.queries).toHaveLength(2);
              expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(
                "private-hook",
              );
            },
          },
          {
            name: "native-hook-markers",
            f: async (task) => {
              while (!rotating) await task.sleep(1, "wait for query shutdown admission");
              const setup = nativeHook("setup", "Setup");
              const resume = nativeHook("resume", "SessionStart");
              await f.query.emit(task, setup);
              await f.query.emit(task, resume);
              await f.query.emit(task, nativeHookResponse(nativeHook("other")));
              expect(f.agent.gateView().activity).toBe("busy");
              await f.query.emit(task, nativeHookResponse(resume));
              await task.checkpoint("one native hook remains despite a different response UUID");
              expect(f.agent.gateView().activity).toBe("busy");
              if (kind === "paired")
                await f.query.emit(task, nativeHookResponse(setup, "cancelled"));
              hooksConsumed = true;
            },
          },
          {
            name: "native-process-exit",
            f: async (task) => {
              while (!rotating) await task.sleep(1, "wait for native shutdown request");
              await task.checkpoint("native process exit independent of native hook stdout");
              f.query.exit();
            },
          },
          {
            name: "native-history-and-EOF",
            f: async (task) => {
              while (!hooksConsumed) await task.sleep(1, "wait for hook stdout consumption");
              await task.checkpoint("final native root append before stdout EOF");
              f.append({
                type: "assistant",
                uuid: "final-native-root",
                message: { content: "final root" },
              });
              f.query.endOutput();
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

it.each(["sync", "commit"] as const)(
  "final native %s failure cannot release ownership or authorize preparation",
  async (failure) => {
    await runDst({ name: `claude-composed-final-${failure}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "native-driver",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              await task.checkpoint("final persistence failpoint armed after root result");
              f.append({ type: "assistant", uuid: "late", message: { content: "late" } });
              if (failure === "sync") f.failSync = true;
              else f.failCommit = true;
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              await task.checkpoint("failed final durability cannot become idle");
              expect(f.agent.gateView().activity).toBe("busy");
              expect(f.agent.prepareIdleStop().isErr()).toBe(true);
              expect(f.agent.getHealth()).toMatchObject({
                status: "failed",
                error: { code: "history_unavailable" },
              });
              expect(
                f.history.view.some(
                  (record) =>
                    record.type === "event" && record.eventType === "claude.operation_finished",
                ),
              ).toBe(false);
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

it("independently scheduled process exit and trailing stdout cannot outrun final native persistence", async () => {
  await runDst(
    { name: "claude-composed-independent-process-stdout", iterations: 40 },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      let draining = false;
      let exited = false;
      let ended = false;
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "owner",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              expect(f.query.closeRequested).toBe(true);
              draining = true;
              await f.agent.closeExtensions();
              await task.checkpoint("all native holds released only after final history commit");
              expect(f.agent.gateView().activity).toBe("idle");
              expect(
                f.agent
                  .replicationSnapshot()
                  ._unsafeUnwrap()
                  .records.some((record) => record.id === "late-output"),
              ).toBe(true);
            },
          },
          {
            name: "process-supervisor",
            f: async (task) => {
              while (!draining) await task.sleep(1, "wait for native close request");
              await task.checkpoint("independent native process exit");
              expect(f.agent.gateView().activity).toBe("busy");
              exited = true;
              f.query.exit();
              if (!ended) expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
            },
          },
          {
            name: "stdout-and-native-writer",
            f: async (task) => {
              while (!draining) await task.sleep(1, "wait for native close request");
              await task.checkpoint("native final append before independent stdout EOF");
              expect(f.agent.gateView().activity).toBe("busy");
              f.append({
                type: "assistant",
                uuid: "late-output",
                message: { content: "late output" },
              });
              await task.checkpoint("native stdout EOF independently of process notification");
              ended = true;
              f.query.endOutput();
              if (!exited) expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    },
  );
});

it.each(["receipt", "uncertain", "child"] as const)(
  "retained %s crash state is qualified without automatic inference or duplicate inbox delivery",
  async (kind) => {
    await runDst({ name: `claude-composed-retained-${kind}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "crash-driver",
            f: async (task) => {
              const accepted = await f.agent.deliverInboxMessage(
                "inbox",
                ["inbox"],
                [{ type: "text", text: "hello" }],
              );
              expect(accepted.isOk()).toBe(true);
              const input = (await f.query.input.next()).value;
              if (input === undefined) throw new Error("expected durable SDK admission");
              if (kind !== "uncertain") f.receipt(input);
              if (kind === "child") await childHook(task, f);
              await task.checkpoint("compute crash with durable submission journal retained");
              f.query.exit();
              f.query.endOutput();
              await f.agent.waitForStream();
              await f.agent.closeExtensions();
              const journal = f.journal();
              const restored = new ClaudeHistory(`${f.dir}/claude`, journal.id, journal.timestamp);
              expect(restored.scan(f.nativePath).isOk()).toBe(true);
              const qualified = qualifyClaudeRestart(
                journal,
                restored.view,
                journal.guardLifetime ?? "claude:0:native",
              );
              if (kind === "receipt")
                expect(qualified._unsafeUnwrap()).toEqual({
                  interruptedOperations: [accepted._unsafeUnwrap().operationId],
                  orphanedChildren: [],
                });
              else
                expect(qualified._unsafeUnwrapErr().code).toBe(
                  kind === "uncertain"
                    ? "claude_delivery_uncertain"
                    : "claude_child_recovery_required",
                );
              const queries = f.queries.length;
              const duplicate = await f.agent.deliverInboxMessage(
                "inbox",
                ["inbox"],
                [{ type: "text", text: "hello" }],
              );
              expect(duplicate._unsafeUnwrap()).toMatchObject({
                duplicate: true,
                status: kind === "uncertain" ? "queued" : "persisted",
              });
              expect(f.queries).toHaveLength(queries);
              expect(Object.values(journal.deliveries)).toHaveLength(1);
              expect(restored.view.filter((record) => record.id === input.uuid)).toHaveLength(
                kind === "uncertain" ? 0 : 1,
              );
              if (kind === "child")
                expect(
                  qualifyClaudeRestart(
                    journal,
                    restored.view,
                    "claude:1:replacement",
                  )._unsafeUnwrap().orphanedChildren,
                ).toEqual(["child"]);
              if (kind === "receipt") {
                const queries: ScheduledClaudeQuery[] = [];
                const replacement = new ClaudeOrbAgent({
                  orbId: "orb-a",
                  repositoryUrl: "https://example.com/repo",
                  workDir: f.dir,
                  skillsDir: null,
                  broker: null,
                  incarnation: "1",
                  sdkFactory: (prompt, options) => {
                    const query = new ScheduledClaudeQuery(prompt, options, queries.length === 0);
                    queries.push(query);
                    return ok({
                      query,
                      exited: query.processExit.promise,
                      stdoutEnded: query.stdoutEnded,
                      requestShutdown: () => query.requestShutdown(),
                    });
                  },
                });
                await task.checkpoint(
                  "new runtime attaches qualified retained files, not product transcript",
                );
                expect(
                  (
                    await replacement.attachSession(journal, restored, f.configDir, "commit-0")
                  ).isOk(),
                ).toBe(true);
                expect(queries).toHaveLength(1);
                expect(queries[0]?.options.resume).toBe(journal.id);
                expect(replacement.gateView().activity).toBe("idle");
                expect(
                  (
                    await replacement.deliverInboxMessage(
                      "inbox",
                      ["inbox"],
                      [{ type: "text", text: "hello" }],
                    )
                  )._unsafeUnwrap(),
                ).toMatchObject({ duplicate: true, status: "persisted" });
                expect(queries).toHaveLength(1);
                await task.checkpoint("only a new owner message admits continuation");
                expect(
                  (
                    await replacement.submitMessage(
                      [{ type: "text", text: "continue manually" }],
                      "manual",
                    )
                  ).isOk(),
                ).toBe(true);
                expect(queries).toHaveLength(2);
                const manualQuery = queries.at(-1);
                if (manualQuery === undefined) throw new Error("manual query missing");
                const manual = (await manualQuery.input.next()).value;
                if (manual === undefined) throw new Error("manual message missing");
                expect(manual.uuid).not.toBe(input.uuid);
                f.receipt(manual);
                await manualQuery.emit(task, rootResult);
                manualQuery.exit();
                manualQuery.endOutput();
                await replacement.closeExtensions();
                await task.checkpoint("manual continuation terminal persisted");
                expect(replacement.gateView().activity).toBe("idle");
                expect(
                  replacement
                    .replicationSnapshot()
                    ._unsafeUnwrap()
                    .records.filter((record) => record.id === input.uuid),
                ).toHaveLength(1);
              }
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
