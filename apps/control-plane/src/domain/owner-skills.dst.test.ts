import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { FakeOwnerSkillSource, FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import {
  describeOwnerSkills,
  importOwnerSkill,
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
      const deps: OwnerSkillsDeps = {
        store,
        source: new FakeOwnerSkillSource({
          content: skill("imported", "import").content,
          files: [],
          source: null,
        }),
        platformSkillNames: new Set(["charts"]),
      };
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

it("DST: pinned imports, manual edits, deletes and adoption observe only complete committed bundles", async () => {
  await runDst(
    {
      name: "owner-skill-bundles",
      iterations: 100,
      failpointProbabilities: {
        ...failpoints,
        "owner-skills.acquire.before": 0.15,
        "owner-skills.acquire.after": 0.15,
      },
    },
    async (sim) => {
      const store = new FakeOwnerSkillStore();
      const files = [{ path: "scripts/run", base64: "AP8=", executable: true }];
      const source = {
        url: "https://github.com/acme/skills/tree/main/example",
        commitSha: "a".repeat(40),
      };
      store.seed(USER, [{ name: "example", ...skill("example", "old"), files, source }]);
      const deps = {
        store,
        source: new FakeOwnerSkillSource({ ...skill("example", "new"), files, source }),
        platformSkillNames: new Set<string>(),
      };
      const adopted: unknown[] = [];
      const result = await sim.runTasks([
        {
          name: "import",
          f: async (task) => {
            await importOwnerSkill(task, deps, USER, source);
          },
        },
        {
          name: "edit",
          f: async (task) => {
            await writeOwnerSkill(task, deps, USER, "example", skill("renamed", "edited"));
          },
        },
        {
          name: "delete",
          f: async (task) => {
            await store.apply(task, USER, { kind: "delete", name: "example" });
          },
        },
        ...["context-a", "context-b"].map((name) => ({
          name,
          f: async (task: SimulationTask) => {
            const snapshot = await readOwnerSkillsSnapshot(task, store, USER);
            if (snapshot.isOk()) adopted.push(snapshot.value.skills);
          },
        })),
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const committed = (store.commits.get(USER) ?? []).map((state) =>
        state.map(({ updatedAt: _updatedAt, ...bundle }) => bundle),
      );
      for (const snapshot of adopted) expect(committed).toContainEqual(snapshot);
      for (const state of store.commits.get(USER) ?? []) {
        expect(new Set(state.map((record) => record.name)).size).toBe(state.length);
        for (const record of state) {
          expect(record.files).toEqual(files);
          expect(record.source).toEqual(source);
        }
      }
    },
  );
});

it("DST: disconnect while a pinned import waits for the owner lock prevents its commit", async () => {
  await runDst({ name: "owner-skill-import-cancellation", iterations: 30 }, async (sim) => {
    const store = new FakeOwnerSkillStore();
    const controller = new AbortController();
    let waiting = false;
    let released = false;
    const source = {
      url: "https://github.com/acme/skills/tree/main/example",
      commitSha: "a".repeat(40),
    };
    const deps: OwnerSkillsDeps = {
      source: new FakeOwnerSkillSource({ ...skill("example", "import"), files: [], source }),
      platformSkillNames: new Set(),
      store: {
        list: store.list.bind(store),
        apply: (task, owner, command, signal) =>
          new ResultAsync(
            (async () => {
              waiting = true;
              await waitUntil(task, "owner lock released", () => released);
              return store.apply(task, owner, command, signal);
            })(),
          ),
      },
    };
    const result = await sim.runTasks([
      {
        name: "import",
        f: async (task) => {
          const imported = await importOwnerSkill(task, deps, USER, source, controller.signal);
          expect(imported._unsafeUnwrapErr().code).toBe("unavailable");
        },
      },
      {
        name: "disconnect",
        f: async (task) => {
          await waitUntil(task, "import waiting for owner lock", () => waiting);
          controller.abort();
          released = true;
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    expect(store.commits.size).toBe(0);
  });
});
