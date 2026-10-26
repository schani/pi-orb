import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import { runDst } from "../testkit/sim.ts";
import {
  describeOwnerSkills,
  type OwnerSkillsDeps,
  readOwnerSkillsSnapshot,
  writeOwnerSkill,
} from "./owner-skills.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const skill = (name: string, tag: string) => ({
  content: `---\nname: ${name}\ndescription: ${tag}\n---\n${tag}\n`,
});
const failpoints = Object.fromEntries(
  ["create", "replace", "delete", "list"].flatMap((op) =>
    ["before", "after"].map((edge) => [`owner-skills.${op}.${edge}`, 0.1]),
  ),
);
type State = ReadonlyArray<{ name: string; content: string }>;
const key = (state: State) => JSON.stringify(state.map(({ name, content }) => [name, content]));

it("DST: concurrent create/rename/delete near the cap keep one consistent set per user", async () => {
  await runDst(
    { name: "owner-skills", iterations: 100, failpointProbabilities: failpoints },
    async (sim) => {
      const store = new FakeOwnerSkillStore();
      store.seed(USER, [
        { name: "shared", ...skill("shared", "v0") },
        ...Array.from({ length: OWNER_SKILL_MAX_COUNT - 3 }, (_, i) => ({
          name: `seed-${i}`,
          ...skill(`seed-${i}`, "v0"),
        })),
      ]);
      const deps: OwnerSkillsDeps = { store, platformSkillNames: new Set(["charts"]) };
      const observed: Array<{ userId: string; state: State }> = [];
      type Reply = ResultAsync<{ items: State } | { skills: State }, unknown>;
      const run = (name: string, userId: string, f: (task: SimulationTask) => Reply) => ({
        name,
        f: async (task: SimulationTask) => {
          const reply = await f(task);
          if (reply.isOk())
            observed.push({
              userId,
              state: "items" in reply.value ? reply.value.items : reply.value.skills,
            });
        },
      });
      const result = await sim.runTasks([
        ...["a", "b", "c"].map((name) =>
          run(`create-${name}`, USER, (task) =>
            writeOwnerSkill(task, deps, USER, null, skill(name, "c")),
          ),
        ),
        run("rename-shared-to-a", USER, (task) =>
          writeOwnerSkill(task, deps, USER, "shared", skill("a", "renamed")),
        ),
        run("delete-shared", USER, (task) =>
          describeOwnerSkills(store.apply(task, USER, { kind: "delete", name: "shared" })),
        ),
        run("other-user", OTHER, (task) =>
          writeOwnerSkill(task, deps, OTHER, null, skill("a", "other")),
        ),
        run("boot", USER, (task) => readOwnerSkillsSnapshot(task, store, USER)),
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      for (const userId of [USER, OTHER]) {
        const committed = new Set([key([]), ...(store.commits.get(userId) ?? []).map(key)]);
        for (const state of store.commits.get(userId) ?? []) {
          const names = state.map((item) => item.name);
          expect(names).toEqual([...new Set(names)].sort());
          expect(names.length).toBeLessThanOrEqual(OWNER_SKILL_MAX_COUNT);
          for (const item of state) expect(item.content).toContain(`name: ${item.name}\n`);
        }
        // Every reply and boot read is one whole committed state of its own user.
        for (const entry of observed.filter((item) => item.userId === userId))
          expect(committed).toContain(key(entry.state));
      }
    },
  );
});
