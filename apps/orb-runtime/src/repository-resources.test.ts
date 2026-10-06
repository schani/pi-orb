import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryResources } from "./repository-resources.ts";

describe("repository resources", () => {
  it("selects first present instructions and fallback skills, following only in-repository aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-resources-"));
    const repo = join(root, "repo");
    try {
      mkdirSync(join(repo, ".pi"), { recursive: true });
      mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
      mkdirSync(join(repo, "skill-assets", "review"), { recursive: true });
      writeFileSync(join(repo, "CLAUDE.md"), "selected");
      writeFileSync(join(repo, "AGENTS.md"), "root");
      symlinkSync("../CLAUDE.md", join(repo, ".pi", "AGENTS.md"));
      writeFileSync(join(repo, "skill-assets", "review", "SKILL.md"), "review");
      symlinkSync("../../skill-assets/review", join(repo, ".agents", "skills", "review"));
      const fallback = repositoryResources(repo);
      expect(fallback.isOk()).toBe(true);
      if (fallback.isErr()) return;
      expect(fallback.value.instructions).toEqual([
        { path: join(repo, ".pi", "AGENTS.md"), content: "selected" },
      ]);
      expect(fallback.value.skills).toEqual([
        join(repo, ".agents", "skills", "review", "SKILL.md"),
      ]);
      mkdirSync(join(repo, ".pi", "skills"));
      expect(repositoryResources(repo)._unsafeUnwrap().skills).toEqual([]);
      writeFileSync(join(root, "outside.md"), "private");
      symlinkSync("../../../outside.md", join(repo, ".pi", "skills", "SKILL.md"));
      expect(repositoryResources(repo).isErr()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not treat a malformed primary directory as absence", () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-resources-"));
    try {
      mkdirSync(join(repo, ".pi"));
      writeFileSync(join(repo, ".pi", "skills"), "not a directory");
      expect(repositoryResources(repo).isErr()).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
