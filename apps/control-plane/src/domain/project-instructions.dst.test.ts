import type { ProjectInstructions } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { expect, it } from "vitest";
import { FakeProjectInstructionsStore } from "../testkit/project-instructions.ts";
import { runDst } from "../testkit/sim.ts";
import { readProjectInstructions, saveProjectInstructions } from "./project-instructions.ts";

const outside = new NoSimulationTask("instructions assertions", false);
it.each([false, true])(
  "DST: project saves/readers/deletion have one atomic scope, faults=%s",
  async (faults) => {
    await runDst(
      {
        name: `project-instructions-${faults}`,
        iterations: 100,
        failpointProbabilities: faults
          ? {
              "project-instructions.write.before": 0.3,
              "project-instructions.write.after": 0.3,
              "project-instructions.read.before": 0.3,
              "project-instructions.read.after": 0.3,
            }
          : {},
      },
      async (sim) => {
        const states = new Map<string, "active" | "deleting">([
          ["a", "active"],
          ["b", "active"],
        ]);
        const store = new FakeProjectInstructionsStore((id) => states.get(id) ?? null);
        const replies: { projectId: string; snapshot: ProjectInstructions }[] = [];
        let atDeletion = 0;
        const result = await sim.runTasks([
          ...["a", "b"].flatMap((projectId) =>
            ["alpha\r\n".repeat(100), "beta 🪐\n".repeat(100), ""].map((text, i) => ({
              name: `${projectId}-writer-${i}`,
              f: async (task: SimulationTask) => {
                const content = text ? `${projectId}\n${text}` : "";
                const saved = await saveProjectInstructions(task, store, projectId, { content });
                if (saved.isOk()) {
                  expect(saved.value.content).toBe(content);
                  replies.push({ projectId, snapshot: saved.value });
                }
              },
            })),
          ),
          ...["a", "b"].map((projectId) => ({
            name: `${projectId}-boot`,
            f: async (task: SimulationTask) => {
              const read = await readProjectInstructions(task, store, projectId);
              if (read.isOk()) replies.push({ projectId, snapshot: read.value });
            },
          })),
          {
            name: "delete-a",
            f: async (task: SimulationTask) => {
              await task.sleep(task.random("deletion order") * 12, "delete admission");
              states.set("a", "deleting");
              atDeletion = store.commits.filter((c) => c.projectId === "a").length;
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        for (const projectId of ["a", "b"]) {
          const history = [
            { content: "", revision: 0 },
            ...store.commits.filter((c) => c.projectId === projectId).map((c) => c.snapshot),
          ];
          expect(history.map((c) => c.revision)).toEqual(history.map((_, i) => i));
          for (const reply of replies.filter((r) => r.projectId === projectId))
            expect(history[reply.snapshot.revision]).toEqual(reply.snapshot);
        }
        expect(store.commits.filter((c) => c.projectId === "a")).toHaveLength(atDeletion);
        expect(
          (
            await saveProjectInstructions(outside, store, "a", { content: "late" })
          )._unsafeUnwrapErr().code,
        ).toBe("conflict");
        const remembered = structuredClone(replies);
        (
          await saveProjectInstructions(outside, store, "b", { content: "next boot only" })
        )._unsafeUnwrap();
        expect(replies).toEqual(remembered);
        expect(
          (await readProjectInstructions(outside, store, "missing"))._unsafeUnwrapErr().code,
        ).toBe("not_found");
        if (!faults) expect(store.commits.filter((c) => c.projectId === "b")).toHaveLength(4);
      },
    );
  },
);
it("rejects invalid input without storage effects", async () => {
  const store = new FakeProjectInstructionsStore(() => "active");
  for (const body of [
    { content: "bad\0" },
    { content: "\ud800" },
    { content: "🪐".repeat(16385) },
    { content: "ok", projectId: "other" },
  ]) {
    expect((await saveProjectInstructions(outside, store, "a", body))._unsafeUnwrapErr().code).toBe(
      "invalid",
    );
  }
  expect(store.commits).toEqual([]);
});
