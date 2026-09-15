import type { PersonalInstructions } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { FakePersonalInstructionsStore } from "../testkit/personal-instructions.ts";
import { runDst } from "../testkit/sim.ts";
import { readPersonalInstructions, savePersonalInstructions } from "./personal-instructions.ts";

const outside = new NoSimulationTask("personal assertions", false);

it.each([false, true])(
  "DST: atomic account-wide saves versus startup reads, failures=%s",
  async (faults) => {
    await runDst(
      {
        name: `personal-instructions-snapshot-${faults}`,
        iterations: 80,
        failpointProbabilities: faults
          ? {
              "personal-instructions.write.before": 0.3,
              "personal-instructions.write.after": 0.3,
              "personal-instructions.read.before": 0.3,
              "personal-instructions.read.after": 0.3,
            }
          : {},
      },
      async (sim) => {
        const store = new FakePersonalInstructionsStore();
        const accepted: PersonalInstructions[] = [];
        const boots: PersonalInstructions[] = [];
        const result = await sim.runTasks([
          ...["alpha\n".repeat(100), "beta\r\n".repeat(100), ""].map((content, index) => ({
            name: `writer-${index}`,
            f: async (task: import("determined").SimulationTask) => {
              const saved = await savePersonalInstructions(task, store, { content });
              if (saved.isOk()) {
                expect(saved.value.content).toBe(content);
                accepted.push(saved.value);
              }
            },
          })),
          ...["project-a-boot", "project-b-boot"].map((name) => ({
            name,
            f: async (task: import("determined").SimulationTask) => {
              const snapshot = await readPersonalInstructions(task, store);
              if (snapshot.isOk()) boots.push(snapshot.value);
            },
          })),
        ]);
        expect(result.isOk()).toBe(true);
        const history = [{ revision: 0, content: "" }, ...store.commits];
        for (const item of [...accepted, ...boots]) expect(history[item.revision]).toEqual(item);
        expect(history.map((item) => item.revision)).toEqual(history.map((_, i) => i));
        const remembered = structuredClone(boots);
        const next = (
          await savePersonalInstructions(outside, store, { content: "next boot only" })
        )._unsafeUnwrap();
        expect(boots).toEqual(remembered);
        expect((await readPersonalInstructions(outside, store))._unsafeUnwrap()).toEqual(next);
        if (!faults) {
          expect(accepted).toHaveLength(3);
          expect(boots).toHaveLength(2);
        }
      },
    );
  },
);

it("rejects invalid writes before touching durable state", async () => {
  const store = new FakePersonalInstructionsStore();
  expect(
    (await savePersonalInstructions(outside, store, { content: "bad\0text" }))._unsafeUnwrapErr()
      .code,
  ).toBe("invalid");
  expect(store.commits).toEqual([]);
});
