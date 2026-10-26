import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OwnerSkillStore } from "../domain/owner-skills.ts";

export interface OwnerSkillStoreSubject {
  readonly store: OwnerSkillStore;
  /** A second handle on the same storage, for concurrent writers. */
  readonly other: OwnerSkillStore;
  /** Creates a fresh existing user, so tests share one opened (migrated) store. */
  user(): Promise<string>;
  /** Commits a starting set directly, bypassing the store's command path. */
  seed(userId: string, names: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

const task = new NoSimulationTask("owner skill store contract", false);
const doc = (name: string, tag = "v") => `---\nname: ${name}\ndescription: ${tag}\n---\n${tag}\n`;
const names = (records: ReadonlyArray<{ name: string }>) => records.map((record) => record.name);

/** One contract body over the simulation fake and every PostgreSQL client. */
export function ownerSkillStoreContractTests(
  name: string,
  open: () => Promise<OwnerSkillStoreSubject>,
): void {
  describe(`${name} owner skill store contract`, () => {
    let subject: OwnerSkillStoreSubject;
    let store: OwnerSkillStore;
    let alice: string;
    let bob: string;
    beforeAll(async () => {
      subject = await open();
      store = subject.store;
    });
    beforeEach(async () => {
      alice = await subject.user();
      bob = await subject.user();
    });
    afterAll(async () => subject.close());

    it("returns the complete per-user set sorted by name after every command", async () => {
      expect((await store.list(task, alice))._unsafeUnwrap()).toEqual([]);
      expect(
        names((await store.create(task, alice, { name: "b", content: doc("b") }))._unsafeUnwrap()),
      ).toEqual(["b"]);
      const both = (
        await store.create(task, alice, { name: "a", content: doc("a") })
      )._unsafeUnwrap();
      expect(names(both)).toEqual(["a", "b"]);
      expect(both[0]).toMatchObject({ name: "a", content: doc("a") });
      expect(Number.isNaN(Date.parse(both[0]?.updatedAt ?? ""))).toBe(false);
      expect(names((await store.list(task, bob))._unsafeUnwrap())).toEqual([]);
      const replaced = (
        await store.replace(task, alice, "b", { name: "b", content: doc("b", "v2") })
      )._unsafeUnwrap();
      expect(replaced.find((record) => record.name === "b")?.content).toBe(doc("b", "v2"));
      const renamed = (
        await store.replace(task, alice, "b", { name: "c", content: doc("c") })
      )._unsafeUnwrap();
      expect(names(renamed)).toEqual(["a", "c"]);
      expect(names((await store.delete(task, alice, "a"))._unsafeUnwrap())).toEqual(["c"]);
      expect((await store.list(task, alice))._unsafeUnwrap()).toEqual(
        (await subject.other.list(task, alice))._unsafeUnwrap(),
      );
    });

    it("types conflicts and missing skills without partial writes", async () => {
      await store.create(task, alice, { name: "a", content: doc("a") });
      await store.create(task, alice, { name: "b", content: doc("b") });
      const before = (await store.list(task, alice))._unsafeUnwrap();
      const code = async (result: ResultAsync<unknown, { code: string }>) =>
        (await result)._unsafeUnwrapErr().code;
      expect(await code(store.create(task, alice, { name: "a", content: doc("a", "x") }))).toBe(
        "conflict",
      );
      expect(
        await code(store.replace(task, alice, "a", { name: "b", content: doc("b", "x") })),
      ).toBe("conflict");
      expect(await code(store.replace(task, alice, "zz", { name: "zz", content: doc("zz") }))).toBe(
        "not_found",
      );
      expect(await code(store.replace(task, bob, "a", { name: "a", content: doc("a") }))).toBe(
        "not_found",
      );
      expect(await code(store.delete(task, alice, "zz"))).toBe("not_found");
      expect((await store.list(task, alice))._unsafeUnwrap()).toEqual(before);
      const unknown = "00000000-0000-4000-8000-0000000000ff";
      expect((await store.create(task, unknown, { name: "a", content: doc("a") })).isErr()).toBe(
        true,
      );
      expect((await store.list(task, unknown))._unsafeUnwrap()).toEqual([]);
    });

    it("enforces the count cap atomically against concurrent writers", async () => {
      await subject.seed(
        alice,
        Array.from({ length: OWNER_SKILL_MAX_COUNT - 2 }, (_, i) => `seed-${i}`),
      );
      const replies = await Promise.all(
        ["a", "b", "c", "d"].map((skill, index) =>
          (index % 2 ? subject.other : store).create(task, alice, {
            name: skill,
            content: doc(skill),
          }),
        ),
      );
      expect(replies.filter((reply) => reply.isOk())).toHaveLength(2);
      for (const reply of replies.filter((reply) => reply.isErr()))
        expect(reply._unsafeUnwrapErr().code).toBe("conflict");
      expect((await store.list(task, alice))._unsafeUnwrap()).toHaveLength(OWNER_SKILL_MAX_COUNT);
      // Renames do not change the count and remain possible at the cap.
      expect(
        (await store.replace(task, alice, "seed-0", { name: "z", content: doc("z") })).isOk(),
      ).toBe(true);
      expect((await store.create(task, bob, { name: "a", content: doc("a") })).isOk()).toBe(true);
    });

    it("lets exactly one of a concurrent rename and create take a name", async () => {
      await store.create(task, alice, { name: "old", content: doc("old") });
      const [renamed, created] = await Promise.all([
        store.replace(task, alice, "old", { name: "new", content: doc("new", "renamed") }),
        subject.other.create(task, alice, { name: "new", content: doc("new", "created") }),
      ]);
      expect([renamed.isOk(), created.isOk()].filter(Boolean)).toHaveLength(1);
      const final = (await store.list(task, alice))._unsafeUnwrap();
      expect(final.filter((record) => record.name === "new")).toHaveLength(1);
      expect(names(final)).toEqual(renamed.isOk() ? ["new"] : ["new", "old"]);
      expect(final.find((record) => record.name === "new")?.content).toBe(
        doc("new", renamed.isOk() ? "renamed" : "created"),
      );
    });
  });
}
