import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { readLiveDisplayDetail } from "./display-detail.ts";
import type { LiveOperationView } from "./types.ts";

it("DST: active detail snapshots are coherent across mutation, commit and late HTTP delivery", async () => {
  await runDst({ name: "lazy-active-detail-commit", iterations: 40 }, async (sim) => {
    let live: LiveOperationView | null = {
      operationId: "op",
      operationKind: "agent",
      blocks: [{ blockId: "thinking", blockType: "reasoning", revision: 1, text: "hidden-one" }],
      tools: [],
      subagents: [],
    };
    let committed = false;
    let delivered: ReturnType<typeof readLiveDisplayDetail> | null = null;
    const result = await sim.runTasks([
      {
        name: "http reader",
        f: async (task) => {
          await task.checkpoint("before snapshot");
          const captured = readLiveDisplayDetail("session", live, "op", "thinking");
          await task.checkpoint("response held in transport");
          delivered = captured;
          if (committed)
            expect(readLiveDisplayDetail("session", live, "op", "thinking").state).toBe(
              "unavailable",
            );
          if (captured.body?.type === "reasoning")
            expect(captured.body.text).toMatch(/^hidden-(one|two)$/);
        },
      },
      {
        name: "runtime writer",
        f: async (task) => {
          await task.checkpoint("before body update");
          live = {
            operationId: "op",
            operationKind: "agent",
            blocks: [
              { blockId: "thinking", blockType: "reasoning", revision: 2, text: "hidden-two" },
            ],
            tools: [],
            subagents: [],
          };
          await task.checkpoint("before commit");
          live = null;
          committed = true;
          expect(readLiveDisplayDetail("session", live, "op", "thinking").state).toBe(
            "unavailable",
          );
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(committed).toBe(true);
    expect(delivered).not.toBeNull();
    // A captured response may arrive after commit; its operation identity allows browser fencing.
    expect(delivered).toMatchObject({ operationId: "op" });
  });
});
