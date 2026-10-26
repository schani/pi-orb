import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { materializeOwnerSkills } from "./owner-skills.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const doc = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`;

it("writes each owner skill as <config>/skills/<name>/SKILL.md, replacing previous contents", () => {
  const configDir = join(mkdtempSync(join(tmpdir(), "owner-skills-")), "config");
  dirs.push(configDir);
  materializeOwnerSkills(configDir, [
    { name: "removed", content: doc("removed") },
    { name: "kept", content: doc("old") },
  ])._unsafeUnwrap();
  mkdirSync(join(configDir, "skills", "kept", "extra"), { recursive: true });
  writeFileSync(join(configDir, "skills", "stray.md"), "stray");
  writeFileSync(join(configDir, "settings.json"), "{}");

  materializeOwnerSkills(configDir, [
    { name: "kept", content: doc("kept") },
    { name: "added", content: doc("added") },
  ])._unsafeUnwrap();
  expect(readdirSync(join(configDir, "skills")).sort()).toEqual(["added", "kept"]);
  expect(readdirSync(join(configDir, "skills", "kept"))).toEqual(["SKILL.md"]);
  expect(readFileSync(join(configDir, "skills", "kept", "SKILL.md"), "utf8")).toBe(doc("kept"));
  expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{}");

  materializeOwnerSkills(configDir, [])._unsafeUnwrap();
  expect(readdirSync(join(configDir, "skills"))).toEqual([]);
  expect(existsSync(join(configDir, "settings.json"))).toBe(true);
});

it("reports filesystem failures as a typed error", () => {
  const root = mkdtempSync(join(tmpdir(), "owner-skills-"));
  dirs.push(root);
  const configDir = join(root, "file");
  writeFileSync(configDir, "not a directory");
  expect(
    materializeOwnerSkills(configDir, [{ name: "a", content: doc("a") }])._unsafeUnwrapErr(),
  ).toEqual({
    message: "Cannot install owner skills for Claude Code.",
  });
});
