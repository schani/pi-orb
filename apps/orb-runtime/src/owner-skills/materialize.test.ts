import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerSkillCapturePath, validateOwnerSkillsSnapshot } from "@pi-orb/protocol";
import { assert, expect, it } from "vitest";
import { materializeOwnerSkills } from "./materialize.ts";

it("validates the whole bundle before writes, copies binary/mode, and rebuilds only its directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "owner-materialize-"));
  const root = join(parent, "skills");
  const skills = [
    {
      name: "science",
      content: "root",
      source: null,
      files: [{ path: "scripts/run", base64: "AP8B", executable: true }],
    },
  ];
  try {
    expect(materializeOwnerSkills(root, skills).isOk()).toBe(true);
    expect(readFileSync(join(root, "science/scripts/run"))).toEqual(Buffer.from([0, 255, 1]));
    expect(statSync(join(root, "science/scripts/run")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "science/SKILL.md")).mode & 0o777).toBe(0o600);
    assert(skills[0]);
    expect(
      materializeOwnerSkills(root, [
        { ...skills[0], files: [{ path: "../escape", base64: "", executable: false }] },
      ]).isErr(),
    ).toBe(true);
    expect(readFileSync(join(root, "science/SKILL.md"), "utf8")).toBe("root");
    rmSync(root, { recursive: true });
    symlinkSync(parent, root);
    expect(materializeOwnerSkills(root, skills).isErr()).toBe(true);
    expect(existsSync(join(parent, "science"))).toBe(false);
    const blocked = join(parent, "blocked");
    writeFileSync(blocked, "file");
    expect(
      materializeOwnerSkills(join(blocked, "nested", "skills"), skills)._unsafeUnwrapErr(),
    ).toMatchObject({
      code: "io",
      message: expect.stringContaining("ENOTDIR"),
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

it("accepts a realistic 500 KiB binary and enforces canonical base64, aggregate files and serialized JSON bounds", () => {
  expect(ownerSkillCapturePath("one")).not.toBe(ownerSkillCapturePath("two"));
  const file = {
    path: "asset.bin",
    base64: Buffer.alloc(500 * 1024, 255).toString("base64"),
    executable: false,
  };
  const skill = { name: "science", content: "root", source: null, files: [file] };
  expect(validateOwnerSkillsSnapshot({ skills: [skill] }).isOk()).toBe(true);
  expect(
    validateOwnerSkillsSnapshot({
      skills: [{ ...skill, files: [{ ...file, base64: "AB==" }] }],
    }).isErr(),
  ).toBe(true);
  expect(
    validateOwnerSkillsSnapshot({
      skills: [
        {
          ...skill,
          files: Array.from({ length: 1000 }, (_, i) => ({
            path: `f-${i}`,
            base64: "",
            executable: false,
          })),
        },
      ],
    }).isErr(),
  ).toBe(true);
  expect(
    validateOwnerSkillsSnapshot({
      skills: [
        { ...skill, files: Array.from({ length: 13 }, (_, i) => ({ ...file, path: `f-${i}` })) },
      ],
    }).isErr(),
  ).toBe(true);
});
