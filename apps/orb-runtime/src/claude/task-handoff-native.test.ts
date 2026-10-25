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
