import type { PersonalInstructions } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { FakePersonalInstructionsStore } from "../testkit/personal-instructions.ts";
import { runDst } from "../testkit/sim.ts";
import { readPersonalInstructions, savePersonalInstructions } from "./personal-instructions.ts";

const outside = new NoSimulationTask("personal assertions", false);
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

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
        const store = new FakePersonalInstructionsStore([USER]);
        const accepted: PersonalInstructions[] = [];
        const boots: PersonalInstructions[] = [];
        const result = await sim.runTasks([
          ...["alpha\n".repeat(100), "beta\r\n".repeat(100), ""].map((content, index) => ({
            name: `writer-${index}`,
            f: async (task: import("determined").SimulationTask) => {
              const saved = await savePersonalInstructions(task, store, USER, { content });
              if (saved.isOk()) {
                expect(saved.value.content).toBe(content);
                accepted.push(saved.value);
              }
            },
          })),
          ...["project-a-boot", "project-b-boot"].map((name) => ({
            name,
            f: async (task: import("determined").SimulationTask) => {
              const snapshot = await readPersonalInstructions(task, store, USER);
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
          await savePersonalInstructions(outside, store, USER, { content: "next boot only" })
        )._unsafeUnwrap();
        expect(boots).toEqual(remembered);
        expect((await readPersonalInstructions(outside, store, USER))._unsafeUnwrap()).toEqual(
          next,
        );
        if (!faults) {
          expect(accepted).toHaveLength(3);
          expect(boots).toHaveLength(2);
        }
      },
    );
  },
);

it("DST: isolates two users across interleaved writes, boot reads, and commit failures", async () => {
  await runDst(
    {
      name: "personal-instructions-two-users",
      iterations: 100,
      failpointProbabilities: {
        "personal-instructions.write.before": 0.25,
        "personal-instructions.write.after": 0.25,
        "personal-instructions.read.before": 0.25,
        "personal-instructions.read.after": 0.25,
      },
    },
    async (sim) => {
      const store = new FakePersonalInstructionsStore([USER, OTHER_USER]);
      const boots = new Map<string, PersonalInstructions[]>([
        [USER, []],
        [OTHER_USER, []],
      ]);
      const tasks = [USER, OTHER_USER].flatMap((userId, userIndex) => [
        ...[0, 1, 2].map((index) => ({
          name: `writer-${userIndex}-${index}`,
          f: async (task: import("determined").SimulationTask) => {
            await savePersonalInstructions(task, store, userId, {
              content: `${userId}:${index}`,
            });
          },
        })),
        ...[0, 1].map((index) => ({
          name: `boot-${userIndex}-${index}`,
          f: async (task: import("determined").SimulationTask) => {
            const read = await readPersonalInstructions(task, store, userId);
            if (read.isOk()) boots.get(userId)?.push(structuredClone(read.value));
          },
        })),
      ]);
      expect((await sim.runTasks(tasks)).isOk()).toBe(true);

      for (const userId of [USER, OTHER_USER]) {
        const history = [{ content: "", revision: 0 }, ...(store.commitsByUser.get(userId) ?? [])];
        expect(history.map((item) => item.revision)).toEqual(history.map((_, index) => index));
        for (const snapshot of boots.get(userId) ?? []) {
          expect(history[snapshot.revision]).toEqual(snapshot);
          expect(snapshot.content === "" || snapshot.content.startsWith(`${userId}:`)).toBe(true);
        }
      }
      const remembered = structuredClone([...boots.values()]);
      await savePersonalInstructions(outside, store, USER, { content: `${USER}:later` });
      expect([...boots.values()]).toEqual(remembered);
    },
  );
});

it("rejects unknown users without creating implicit state", async () => {
  const store = new FakePersonalInstructionsStore([USER]);
  expect((await store.read(outside, OTHER_USER)).isErr()).toBe(true);
  expect((await store.replace(outside, OTHER_USER, "no")).isErr()).toBe(true);
  expect(store.snapshots.has(OTHER_USER)).toBe(false);
});

it("rejects invalid writes before touching durable state", async () => {
  const store = new FakePersonalInstructionsStore([USER]);
  expect(
    (
      await savePersonalInstructions(outside, store, USER, { content: "bad\0text" })
    )._unsafeUnwrapErr().code,
  ).toBe("invalid");
  expect(store.commits).toEqual([]);
});
