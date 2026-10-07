import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each([false, true])(
  "native compaction owns input through canonical persistence and independently scheduled drain (cancel=%s)",
  async (cancel) => {
    await runDst({ name: `claude-manual-compaction-${cancel}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        await f.attach();
        let submitted = false;
        let cancelling = false;
        let ingressChecked = false;
        let terminal = false;
        const next = f.nextQuery();
        const compacting = f.agent.compact(undefined, "compact-op");
        const query = await next;
        const input = await query.input.next();
        const result = await sim.runTasks([
          {
            name: "native",
            f: async (task) => {
              expect(input.done, "native command available").toBe(false);
              f.receipt(input.value!);
              submitted = true;
              await task.checkpoint("private compaction command consumed");
              while (!ingressChecked) await task.sleep(1, "wait for held-inbox assertion");
              if (cancel) while (!cancelling) await task.sleep(1, "wait for cancel admission");
              else {
                f.append({
                  type: "system",
                  subtype: "compact_boundary",
                  uuid: "boundary",
                  content: "Conversation compacted",
                  compactMetadata: { trigger: "manual" },
                });
                await task.checkpoint("boundary durable before canonical summary");
                expect(f.agent.gateView().activity).toBe("busy");
                f.append({
                  type: "user",
                  uuid: "summary",
                  parentUuid: "boundary",
                  isCompactSummary: true,
                  message: { content: "native summary" },
                });
              }
              await query.emit(task, rootResult);
              await task.checkpoint("result is not idle");
              query.exit();
              await task.checkpoint("process exit before trailing stdout EOF");
              expect(f.agent.gateView().activity).toBe("busy");
              query.endOutput();
            },
          },
          {
            name: "ingress",
            f: async (task) => {
              while (!submitted) await task.sleep(1, "wait for native input");
              expect(
                (
                  await f.agent.deliverInboxMessage(
                    "queued",
                    ["queued"],
                    [{ type: "text", text: "waiting" }],
                  )
                ).isErr(),
                "inbox held",
              ).toBe(true);
              expect(f.journal().deliveries).toEqual({});
              expect(f.agent.canCompact().isErr()).toBe(true);
              ingressChecked = true;
              if (cancel) {
                cancelling = true;
                await f.agent.abortOperation();
              }
              while (!terminal)
                await task.sleep(1, "retain ingress owner until terminal publication");
            },
          },
          {
            name: "terminal",
            f: async (task) => {
              const outcome = await compacting;
              expect(
                outcome.isOk(),
                outcome.isErr()
                  ? JSON.stringify({ error: outcome.error, health: f.agent.getHealth() })
                  : "completed",
              ).toBe(!cancel);
              await task.checkpoint("typed terminal committed before idle");
              expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
              expect(f.history.view.some((record) => record.type === "compaction")).toBe(!cancel);
              expect(
                f.history.view.filter(
                  (record) => record.type === "event" && record.compaction?.outcome === "aborted",
                ),
              ).toHaveLength(cancel ? 1 : 0);
              terminal = true;
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
