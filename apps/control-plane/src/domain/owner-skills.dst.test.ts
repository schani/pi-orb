import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { okAsync, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import { runDst } from "../testkit/sim.ts";
import {
  createOwnerSkill,
  deleteOwnerSkill,
  listOwnerSkills,
  type OwnerSkillsDeps,
  readOwnerSkillsSnapshot,
  replaceOwnerSkill,
} from "./owner-skills.ts";

const outside = new NoSimulationTask("owner skill assertions", false);
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const skill = (name: string, tag: string) =>
  `---\nname: ${name}\ndescription: ${name} ${tag}\n---\n${tag}\n`;
const failpoints = Object.fromEntries(
  ["create", "replace", "delete", "list"].flatMap((name) =>
    ["before", "after"].map((edge) => [`owner-skills.${name}.${edge}`, 0.2]),
  ),
);
type State = ReadonlyArray<{ name: string; content: string }>;
const shape = (items: State): State => items.map(({ name, content }) => ({ name, content }));

function scenario(store: FakeOwnerSkillStore) {
  const deps: OwnerSkillsDeps = { store, platformSkillNames: () => okAsync(new Set(["charts"])) };
  const observed: Array<{ userId: string; state: State }> = [];
  const remember = (userId: string) => (result: Result<{ items: State }, unknown>) => {
    if (result.isOk()) observed.push({ userId, state: shape(result.value.items) });
  };
  const boot = (userId: string) => async (task: SimulationTask) => {
    const read = await readOwnerSkillsSnapshot(task, store, userId);
    if (read.isOk()) observed.push({ userId, state: shape(read.value.skills) });
  };
  /** Invariants over every committed state, then linearizability of every observed reply. */
  const check = () => {
    for (const userId of [USER, OTHER]) {
      const committed = store.statesByUser(userId).map((state) => {
        const names = state.map((item) => item.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual([...names].sort());
        expect(state.length).toBeLessThanOrEqual(OWNER_SKILL_MAX_COUNT);
        // No torn content: every stored document still declares exactly the row's name.
        for (const item of state)
          expect(item.content.startsWith(`---\nname: ${item.name}\n`)).toBe(true);
        return JSON.stringify(shape(state));
      });
      for (const item of observed.filter((entry) => entry.userId === userId))
        expect(committed).toContain(JSON.stringify(item.state));
    }
  };
  return { deps, observed, remember, boot, check };
}

it.each([false, true])(
  "DST: concurrent create/rename/replace/delete keep one consistent set per user, failures=%s",
  async (faults) => {
    await runDst(
      {
        name: `owner-skills-names-${faults}`,
        iterations: 150,
        failpointProbabilities: faults ? failpoints : {},
      },
      async (sim) => {
        const store = new FakeOwnerSkillStore([USER, OTHER]);
        store.seed(USER, [{ name: "shared", content: skill("shared", "v0") }]);
        const { deps, observed, remember, boot, check } = scenario(store);
        const run = (name: string, f: (task: SimulationTask) => Promise<unknown>) => ({ name, f });
        const result = await sim.runTasks([
          run("create-a", async (task) =>
            remember(USER)(await createOwnerSkill(task, deps, USER, { content: skill("a", "c") })),
          ),
          run("create-shared", async (task) =>
            remember(USER)(
              await createOwnerSkill(task, deps, USER, { content: skill("shared", "dup") }),
            ),
          ),
          run("rename-shared-to-a", async (task) =>
            remember(USER)(
              await replaceOwnerSkill(task, deps, USER, "shared", { content: skill("a", "r") }),
            ),
          ),
          run("replace-shared", async (task) =>
            remember(USER)(
              await replaceOwnerSkill(task, deps, USER, "shared", {
                content: skill("shared", "v1"),
              }),
            ),
          ),
          run("delete-shared", async (task) =>
            remember(USER)(await deleteOwnerSkill(task, store, USER, "shared")),
          ),
          run("other-user", async (task) =>
            remember(OTHER)(
              await createOwnerSkill(task, deps, OTHER, { content: skill("a", "other") }),
            ),
          ),
          run("boot-user", boot(USER)),
          run("boot-other", boot(OTHER)),
          run("browser-list", async (task) =>
            remember(USER)(await listOwnerSkills(task, store, USER)),
          ),
        ]);
        expect(result.isOk()).toBe(true);
        check();
        for (const { state } of observed.filter((entry) => entry.userId === OTHER))
          expect(state.every((item) => item.content.includes("other"))).toBe(true);
        const final = (await listOwnerSkills(outside, store, USER))._unsafeUnwrap().items;
        if (!faults) {
          // Either the create or the rename takes "a"; the loser gets a typed conflict/not_found.
          expect(final.some((item) => item.name === "a")).toBe(true);
        }
        // Boot snapshots are values, never aliases of later state.
        const remembered = structuredClone(observed);
        await createOwnerSkill(outside, deps, OTHER, { content: skill("later", "x") });
        expect(observed).toEqual(remembered);
      },
    );
  },
);

it.each([false, true])(
  "DST: concurrent creates never exceed the per-owner skill cap, failures=%s",
  async (faults) => {
    await runDst(
      {
        name: `owner-skills-cap-${faults}`,
        iterations: 30,
        failpointProbabilities: faults ? failpoints : {},
      },
      async (sim) => {
        const store = new FakeOwnerSkillStore([USER, OTHER]);
        store.seed(
          USER,
          Array.from({ length: OWNER_SKILL_MAX_COUNT - 2 }, (_, i) => ({
            name: `seed-${i}`,
            content: skill(`seed-${i}`, "v0"),
          })),
        );
        const { deps, remember, boot, check } = scenario(store);
        const created: string[] = [];
        const result = await sim.runTasks([
          ...["a", "b", "c", "d"].map((name) => ({
            name: `create-${name}`,
            f: async (task: SimulationTask) => {
              const reply = await createOwnerSkill(task, deps, USER, { content: skill(name, "c") });
              remember(USER)(reply);
              if (reply.isOk()) created.push(name);
              else if (!faults) expect(reply.error.code).toBe("conflict");
            },
          })),
          {
            name: "delete-seed",
            f: async (task: SimulationTask) =>
              remember(USER)(await deleteOwnerSkill(task, store, USER, "seed-0")),
          },
          { name: "boot", f: boot(USER) },
        ]);
        expect(result.isOk()).toBe(true);
        check();
        const final = store.statesByUser(USER).at(-1) ?? [];
        expect(final.length).toBeLessThanOrEqual(OWNER_SKILL_MAX_COUNT);
        if (!faults) expect(created.length).toBeGreaterThanOrEqual(2);
      },
    );
  },
);
