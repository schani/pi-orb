import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeTaskHandoff } from "../../../../scripts/claude-sdk-contract/task-handoff.mjs";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";

it
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each(["after-result", "during-response"] as const)(
  "native task completion %s preserves production ownership until the actual root handoff",
  async (release) => {
    const f = new ComposedClaudeFixture();
    const edges: Record<string, unknown>[] = [];
    try {
      expect((await f.attach()).isOk()).toBe(true);
      expect(
        (
          await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }])
        ).isOk(),
      ).toBe(true);
      const input = await f.query.input.next();
      if (input.done) throw new Error("Native input missing.");
      const result = await probeTaskHandoff({
        cwd: f.dir,
        configDir: f.configDir,
        sessionId: f.state.id,
        input: input.value,
        release,
        onMessage: async (message) => {
          if (message.type === "result") {
            const edge = {
              type: message.type,
              resultId: message.uuid,
              subtype: message.subtype,
              numTurns: message.num_turns,
              stopReason: message.stop_reason,
              queuedTurns: message.queued_turn_count,
              isError: message.is_error,
              emptyResult: message.subtype === "success" && message.result === "",
              closing: f.query.closeRequested,
            };
            edges.push(edge);
            if (message.num_turns === 0)
              expect(edge).toMatchObject({
                subtype: "success",
                stopReason: null,
                queuedTurns: 0,
                isError: false,
                emptyResult: true,
              });
          } else if (
            message.type === "system" &&
            (message.subtype === "task_started" ||
              message.subtype === "task_notification" ||
              message.subtype === "status" ||
              message.subtype === "background_tasks_changed")
          ) {
            edges.push({
              type: message.type,
              subtype: message.subtype,
              messageId: message.uuid,
              closing: f.query.closeRequested,
            });
          }
          expect(await f.query.emitUnscheduled(message)).toBe(true);
          return f.query.closeRequested;
        },
      });
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(result.acknowledgments).toBeGreaterThan(0);
      expect(result.closedAtAcknowledgment).toBe(false);
      expect(result.rootActivityAfterClose).toBe(false);
      expect(result.requests).toBe(4);
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(
        f.history.view.find(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toMatchObject({ overflow: { outcome: "completed" } });
      expect(
        f.history.view.some(
          (record) => record.type === "event" && record.eventType === "claude.handoff_result",
        ),
      ).toBe(true);
    } finally {
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      const artifactDir = process.env["CLAUDE_HANDOFF_ARTIFACT_DIR"];
      if (artifactDir !== undefined) {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          join(artifactDir, `native-task-handoff-${release}.json`),
          JSON.stringify(
            {
              edges,
              health: f.agent.getHealth(),
              decisions: f.history.view
                .filter(
                  (record) =>
                    record.type === "event" &&
                    [
                      "claude.handoff_result",
                      "claude.rotation_failed",
                      "claude.operation_finished",
                    ].includes(record.eventType),
                )
                .map((record) => ({ id: record.id, overflow: record.overflow })),
            },
            null,
            2,
          ),
        );
      }
      f.dispose();
    }
  },
  30_000,
);

it
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each(["after-result", "during-response"] as const)(
  "native terminal API failure cancels task continuations %s without losing terminal proof",
  async (release) => {
    const f = new ComposedClaudeFixture();
    const edges: Record<string, unknown>[] = [];
    let nativeResult: Awaited<ReturnType<typeof probeTaskHandoff>> | undefined;
    try {
      expect((await f.attach()).isOk()).toBe(true);
      expect(
        (
          await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }])
        ).isOk(),
      ).toBe(true);
      const input = await f.query.input.next();
      if (input.done) throw new Error("Native input missing.");
      nativeResult = await probeTaskHandoff({
        cwd: f.dir,
        configDir: f.configDir,
        sessionId: f.state.id,
        input: input.value,
        release,
        terminalFailure: true,
        spawnProcess: f.query.options.spawnClaudeCodeProcess,
        onQuery: (query) => {
          f.query.interrupt = query.interrupt;
          const requestShutdown = f.query.requestShutdown.bind(f.query);
          f.query.requestShutdown = () => {
            query.requestShutdown();
            return requestShutdown();
          };
        },
        onMessage: async (message) => {
          if (message.type === "result")
            edges.push({
              type: message.type,
              subtype: message.subtype,
              resultId: message.uuid,
              isError: message.is_error,
              numTurns: message.num_turns,
              queuedTurns: message.queued_turn_count,
              pendingHandoffs: Object.keys(f.state.pendingHandoffs ?? {}).length,
              closing: f.query.closeRequested,
            });
          if (message.type === "assistant" && message.error !== undefined)
            edges.push({ type: message.type, error: message.error });
          if (
            message.type === "system" &&
            ["task_notification", "task_started", "status", "background_tasks_changed"].includes(
              message.subtype,
            )
          )
            edges.push({
              type: message.type,
              subtype: message.subtype,
              status: "status" in message ? message.status : undefined,
              taskId: "task_id" in message ? message.task_id : undefined,
              closing: f.query.closeRequested,
              tasks:
                "tasks" in message
                  ? message.tasks.map((task) => ({ taskId: task.task_id }))
                  : undefined,
            });
          expect(await f.query.emitUnscheduled(message)).toBe(true);
          return f.query.closeRequested;
        },
      });
      expect(nativeResult.nativeExit).toBe(true);
      if (nativeResult.iteratorError !== undefined) f.query.failOutput(nativeResult.iteratorError);
      else f.query.endOutput();
      f.query.exit();
      await f.agent.closeExtensions();
      expect(nativeResult).toMatchObject({
        requests: release === "during-response" ? 3 : 2,
        responses: 2,
        continuationAborted: release === "during-response",
        interruptions: 1,
        terminalNotifications: 2,
        nativeExit: true,
        stdoutEOF: true,
        processGroupOwned: true,
        exitSignal: null,
        interruptReceipt: { still_queued: [], cancelled: [] },
        cliVersion: "2.1.310",
        sdkVersion: "0.3.310",
      });
      expect(nativeResult.capabilities).toContain("interrupt_cancel_queued_v1");
      expect(release === "after-result" ? [1] : [0, 1]).toContain(nativeResult.exitCode);
      if (nativeResult.exitCode === 1)
        expect(["process_exited_nonzero", "error_result"]).toContain(
          (nativeResult.iteratorError as { errorClass: string }).errorClass,
        );
      expect(edges).toContainEqual(
        expect.objectContaining({ type: "assistant", error: "rate_limit" }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          type: "result",
          subtype: "success",
          isError: true,
          pendingHandoffs: release === "during-response" ? 2 : 0,
        }),
      );
      const failureIndex = edges.findIndex(
        (edge) => edge.type === "result" && edge.isError === true,
      );
      const notifications = edges.filter((edge) => edge.subtype === "task_notification");
      expect(notifications).toHaveLength(2);
      for (const notification of notifications) {
        if (release === "after-result")
          expect(edges.indexOf(notification)).toBeGreaterThan(failureIndex);
        else expect(edges.indexOf(notification)).toBeLessThan(failureIndex);
        expect(notification.status).toBe(release === "after-result" ? "stopped" : "completed");
      }
      expect(
        edges.filter((edge) => edge.subtype === "background_tasks_changed").at(-1),
      ).toMatchObject({ tasks: [] });
      const finished = f.history.view.filter(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      );
      if (release === "after-result") expect(nativeResult.rootActivityAfterClose).toBe(false);
      if (nativeResult.rootActivityAfterClose) {
        expect(f.agent.getHealth()).toMatchObject({
          status: "failed",
          error: { code: "claude_rotation_uncertain" },
        });
        expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
        expect(finished).toEqual([]);
        expect(f.history.view).toContainEqual(
          expect.objectContaining({ type: "event", eventType: "claude.rotation_failed" }),
        );
        expect(Object.keys(f.state.pendingHandoffs ?? {}).sort()).toEqual(
          notifications.map((edge) => edge.taskId).sort(),
        );
      } else {
        expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
        expect(finished).toMatchObject([
          { overflow: { outcome: "failed", cancellation: "drained" } },
        ]);
        expect(
          f.history.view.some(
            (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
          ),
        ).toBe(false);
        for (const notification of notifications)
          expect(f.history.view).toContainEqual(
            expect.objectContaining({
              type: "event",
              eventType: "claude.handoff_interrupted",
              overflow: expect.objectContaining({
                taskId: notification.taskId,
                reason: "failed_result",
                automaticReplay: false,
              }),
            }),
          );
        expect(f.state.pendingHandoffs).toEqual({});
      }
      const receipt = nativeResult.trace.findIndex((edge) => edge.edge === "interrupt_receipt");
      const shutdown = nativeResult.trace.findIndex((edge) => edge.edge === "shutdown_requested");
      expect(receipt).toBeGreaterThanOrEqual(0);
      expect(shutdown).toBeGreaterThan(receipt);
      if (release === "during-response") {
        const held = nativeResult.trace.findIndex(
          (edge) => edge.edge === "continuation_response_held",
        );
        const forwarded = nativeResult.trace.findIndex(
          (edge) => edge.edge === "failed_result_forwarded",
        );
        const interrupt = nativeResult.trace.findIndex(
          (edge) => edge.edge === "interrupt_requested",
        );
        expect(held).toBeGreaterThanOrEqual(0);
        expect(forwarded).toBeGreaterThan(held);
        expect(interrupt).toBeGreaterThan(forwarded);
        expect(receipt).toBeGreaterThan(interrupt);
        expect(nativeResult.trace).toContainEqual(
          expect.objectContaining({ edge: "continuation_response_closed", aborted: true }),
        );
      }
      expect(f.state.ownedTasks).toEqual({});
      expect(f.state.ownedBackgroundTasks).toEqual({});
    } finally {
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      const artifactDir = process.env["CLAUDE_HANDOFF_ARTIFACT_DIR"];
      if (artifactDir !== undefined) {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          join(artifactDir, `native-terminal-failure-${release}.json`),
          JSON.stringify(
            {
              edges,
              nativeResult,
              health: f.agent.getHealth(),
              decisions: f.history.view
                .filter(
                  (record) =>
                    record.type === "event" &&
                    [
                      "claude.operation_finished",
                      "claude.handoff_interrupted",
                      "claude.rotation_failed",
                      "claude.result_error",
                    ].includes(record.eventType),
                )
                .map((record) => ({
                  id: record.id,
                  eventType: record.type === "event" ? record.eventType : undefined,
                  overflow: record.overflow,
                })),
            },
            null,
            2,
          ),
        );
      }
      f.dispose();
    }
  },
  30_000,
);
