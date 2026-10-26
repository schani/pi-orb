import { OWNER_SKILL_MAX_BYTES, OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import {
  createOwnerSkill,
  deleteOwnerSkill,
  listOwnerSkills,
  type OwnerSkillsDeps,
  parseOwnerSkill,
  readOwnerSkillsSnapshot,
  replaceOwnerSkill,
} from "./owner-skills.ts";

const task = new NoSimulationTask("owner skills", false);
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const skill = (name: string, description = `${name} help`, body = "Steps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
function deps(): OwnerSkillsDeps & { store: FakeOwnerSkillStore } {
  return {
    store: new FakeOwnerSkillStore([USER, OTHER]),
    platformSkillNames: () => okAsync(new Set(["charts", "codemode"])),
  };
}

describe("owner skill validation", () => {
  it("takes the authoritative name and description from Pi-parsed frontmatter", () => {
    expect(
      parseOwnerSkill({ content: skill("release-notes", "Draft notes") })._unsafeUnwrap(),
    ).toEqual({
      name: "release-notes",
      description: "Draft notes",
      content: skill("release-notes", "Draft notes"),
    });
    expect(
      parseOwnerSkill({
        content: '﻿---\r\nname: "pg2"\r\ndescription: >\r\n  folded\r\n---\r\nbody',
      })._unsafeUnwrap().description,
    ).toBe("folded\n");
  });

  it.each([
    ["missing body", undefined],
    ["extra key", { content: skill("a"), name: "a" }],
    ["non-string", { content: 1 }],
    ["NUL", { content: `${skill("a")}\0` }],
    ["lone surrogate", { content: `${skill("a")}\ud800` }],
    ["too many bytes", { content: skill("a", "d", "é".repeat(OWNER_SKILL_MAX_BYTES / 2)) }],
    ["no frontmatter", { content: "# just markdown" }],
    ["malformed YAML", { content: "---\nname: [a\ndescription: x\n---\n" }],
    ["array frontmatter", { content: "---\n- a\n---\n" }],
    ["missing name", { content: "---\ndescription: x\n---\n" }],
    ["numeric name", { content: "---\nname: 12\ndescription: x\n---\n" }],
    ["uppercase name", { content: skill("Release") }],
    ["double hyphen", { content: skill("a--b") }],
    ["long name", { content: skill("a".repeat(65)) }],
    ["blank description", { content: "---\nname: a\ndescription: '  '\n---\n" }],
    ["missing description", { content: "---\nname: a\n---\n" }],
    ["long description", { content: skill("a", "d".repeat(1025)) }],
  ])("rejects %s", (_label, body) => {
    expect(parseOwnerSkill(body)._unsafeUnwrapErr()).toMatchObject({
      type: "owner_skill_error",
      code: "invalid",
    });
  });

  it("accepts exactly the byte and description limits", () => {
    const head = skill("a", "d".repeat(1024), "");
    const content = head + "x".repeat(OWNER_SKILL_MAX_BYTES - Buffer.byteLength(head));
    expect(Buffer.byteLength(content)).toBe(OWNER_SKILL_MAX_BYTES);
    expect(parseOwnerSkill({ content }).isOk()).toBe(true);
  });
});

describe("owner skill commands", () => {
  it("creates, lists sorted, replaces, renames and deletes, returning the full list", async () => {
    const d = deps();
    const created = (
      await createOwnerSkill(task, d, USER, { content: skill("zeta") })
    )._unsafeUnwrap();
    expect(created.items.map((item) => item.name)).toEqual(["zeta"]);
    expect(created.items[0]).toMatchObject({ description: "zeta help", content: skill("zeta") });
    expect(typeof created.items[0]?.updatedAt).toBe("string");
    await createOwnerSkill(task, d, USER, { content: skill("alpha") });
    expect(
      (await listOwnerSkills(task, d.store, USER))._unsafeUnwrap().items.map((i) => i.name),
    ).toEqual(["alpha", "zeta"]);
    const replaced = (
      await replaceOwnerSkill(task, d, USER, "zeta", { content: skill("zeta", "new help") })
    )._unsafeUnwrap();
    expect(replaced.items.find((item) => item.name === "zeta")?.description).toBe("new help");
    const renamed = (
      await replaceOwnerSkill(task, d, USER, "zeta", { content: skill("beta") })
    )._unsafeUnwrap();
    expect(renamed.items.map((item) => item.name)).toEqual(["alpha", "beta"]);
    const deleted = (await deleteOwnerSkill(task, d.store, USER, "alpha"))._unsafeUnwrap();
    expect(deleted.items.map((item) => item.name)).toEqual(["beta"]);
    expect((await readOwnerSkillsSnapshot(task, d.store, USER))._unsafeUnwrap()).toEqual({
      skills: [{ name: "beta", content: skill("beta") }],
    });
    expect((await readOwnerSkillsSnapshot(task, d.store, OTHER))._unsafeUnwrap()).toEqual({
      skills: [],
    });
  });

  it("maps name collisions, missing skills and the count cap to typed errors", async () => {
    const d = deps();
    await createOwnerSkill(task, d, USER, { content: skill("a") });
    await createOwnerSkill(task, d, USER, { content: skill("b") });
    const code = async (result: ResultAsync<unknown, { code: string }>) =>
      (await result)._unsafeUnwrapErr().code;
    expect(await code(createOwnerSkill(task, d, USER, { content: skill("a", "other") }))).toBe(
      "conflict",
    );
    expect(await code(replaceOwnerSkill(task, d, USER, "a", { content: skill("b") }))).toBe(
      "conflict",
    );
    expect(await code(replaceOwnerSkill(task, d, USER, "missing", { content: skill("c") }))).toBe(
      "not_found",
    );
    expect(await code(deleteOwnerSkill(task, d.store, USER, "missing"))).toBe("not_found");
    expect(await code(replaceOwnerSkill(task, d, USER, "a", { content: "bad" }))).toBe("invalid");
    expect((await createOwnerSkill(task, d, OTHER, { content: skill("a") })).isOk()).toBe(true);
    for (let i = 2; i < OWNER_SKILL_MAX_COUNT; i++)
      (await createOwnerSkill(task, d, USER, { content: skill(`s${i}`) }))._unsafeUnwrap();
    expect(await code(createOwnerSkill(task, d, USER, { content: skill("one-more") }))).toBe(
      "conflict",
    );
    expect((await listOwnerSkills(task, d.store, USER))._unsafeUnwrap().items).toHaveLength(
      OWNER_SKILL_MAX_COUNT,
    );
    expect(
      (await replaceOwnerSkill(task, d, USER, "a", { content: skill("renamed-at-cap") })).isOk(),
    ).toBe(true);
  });

  it("rejects bundled platform skill names before touching storage", async () => {
    const d = deps();
    for (const write of [
      () => createOwnerSkill(task, d, USER, { content: skill("charts") }),
      () => replaceOwnerSkill(task, d, USER, "x", { content: skill("codemode") }),
    ])
      expect((await write())._unsafeUnwrapErr()).toMatchObject({ code: "invalid" });
    expect(d.store.commits).toEqual([]);
    const unavailable = {
      ...d,
      platformSkillNames: () =>
        errAsync({
          type: "owner_skill_error" as const,
          code: "internal" as const,
          message: "Bundled platform skills unavailable",
        }),
    };
    expect(
      (await createOwnerSkill(task, unavailable, USER, { content: skill("x") }))._unsafeUnwrapErr()
        .code,
    ).toBe("internal");
    expect(d.store.commits).toEqual([]);
  });

  it("rejects unknown users without creating implicit state", async () => {
    const d = deps();
    const unknown = "00000000-0000-4000-8000-000000000099";
    expect((await createOwnerSkill(task, d, unknown, { content: skill("a") })).isErr()).toBe(true);
    expect(d.store.commits).toEqual([]);
  });
});
