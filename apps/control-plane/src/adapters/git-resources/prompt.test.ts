import { expect, it } from "vitest";
import type { ResourceSnapshot } from "../../domain/resources.ts";
import { snapshotPromptResources } from "./prompt.ts";

it("parses adopted resources offline and keeps only progressively advertised skills", () => {
  const snapshot: ResourceSnapshot = {
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: "AGENTS.md",
    skillRoot: ".agents/skills",
    files: [
      { path: "AGENTS.md", bytes: Buffer.from("instructions"), sha256: "hash" },
      {
        path: ".agents/skills/a/SKILL.md",
        bytes: Buffer.from(
          "---\nname: a\ndescription: useful skill\n---\nFull body stays in reader",
        ),
        sha256: "hash",
      },
      {
        path: ".agents/skills/a/assets/SKILL.md",
        bytes: Buffer.from("asset is not another skill"),
        sha256: "hash",
      },
    ],
  };
  const result = snapshotPromptResources(snapshot);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.instructions).toEqual([{ path: "AGENTS.md", content: "instructions" }]);
    expect(
      result.value.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
      })),
    ).toEqual([{ name: "a", description: "useful skill", filePath: ".agents/skills/a/SKILL.md" }]);
  }
});
it("rejects malformed required skill metadata without silent omission", () => {
  const result = snapshotPromptResources({
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: ".pi/skills",
    files: [
      {
        path: ".pi/skills/a/SKILL.md",
        sha256: "hash",
        bytes: Buffer.from("---\nname: a\n---\nmissing description"),
      },
    ],
  });
  expect(result.isErr()).toBe(true);
});

it("warns without content, skips invalid siblings, and resolves duplicates in path order", () => {
  const texts: Array<[string, string]> = [
    ["z/SKILL.md", "---\nname: good\ndescription: duplicate SECRET\n---\n"],
    ["yaml/SKILL.md", "---\ndescription: default-DENY: SECRET\n---\n"],
    ["meta/SKILL.md", "---\nname: [SECRET]\ndescription: bad\n---\n"],
    ["a/SKILL.md", "---\nname: good\ndescription: valid\n---\n"],
  ];
  const files = texts.map(([path, text]) => ({
    path: `.pi/skills/${path}`,
    bytes: Buffer.from(text),
    sha256: "hash",
  }));
  files.push({ path: ".pi/skills/utf/SKILL.md", bytes: Buffer.from([255]), sha256: "hash" });
  const snapshot: ResourceSnapshot = {
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: ".pi/skills",
    files,
  };
  for (const input of [files, [...files].reverse()]) {
    const result = snapshotPromptResources(
      { ...snapshot, files: input },
      { invalidSkills: "warn" },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.skills.map((s) => s.filePath)).toEqual([".pi/skills/a/SKILL.md"]);
      expect(result.value.warnings).toEqual([
        { path: ".pi/skills/meta/SKILL.md", code: "invalid_metadata" },
        { path: ".pi/skills/utf/SKILL.md", code: "invalid_utf8" },
        { path: ".pi/skills/yaml/SKILL.md", code: "invalid_yaml" },
        { path: ".pi/skills/z/SKILL.md", code: "duplicate_name" },
      ]);
      expect(JSON.stringify(result.value.warnings)).not.toContain("SECRET");
    }
  }
  expect(snapshotPromptResources(snapshot).isErr()).toBe(true);
});

it("warn mode still rejects missing or invalid instructions with a safe path", () => {
  for (const files of [[], [{ path: "AGENTS.md", bytes: Buffer.from([255]), sha256: "hash" }]]) {
    const result = snapshotPromptResources(
      {
        orbId: "orb",
        commitSha: "a".repeat(40),
        instructionPath: "AGENTS.md",
        skillRoot: ".pi/skills",
        files,
      },
      { invalidSkills: "warn" },
    );
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toContain("AGENTS.md");
  }
});

it.each(["SECRET", "42", "true", "[SECRET]", "null"])(
  "rejects non-mapping YAML metadata safely: %s",
  (yaml) => {
    const path = ".pi/skills/bad/SKILL.md";
    const snapshot: ResourceSnapshot = {
      orbId: "orb",
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: ".pi/skills",
      files: [
        { path, bytes: Buffer.from(`---\n${yaml}\n---\nSECRET body`), sha256: "hash" },
        {
          path: ".pi/skills/good/SKILL.md",
          bytes: Buffer.from("---\ndescription: valid sibling\n---\n"),
          sha256: "hash",
        },
      ],
    };
    const strict = snapshotPromptResources(snapshot);
    expect(strict.isErr()).toBe(true);
    if (strict.isErr()) {
      expect(strict.error.message).toContain(JSON.stringify(path));
      expect(strict.error.message).not.toContain("SECRET");
    }
    const warned = snapshotPromptResources(snapshot, { invalidSkills: "warn" });
    expect(warned.isOk()).toBe(true);
    if (warned.isOk()) {
      expect(warned.value.skills.map((skill) => skill.name)).toEqual(["good"]);
      expect(warned.value.warnings).toEqual([{ path, code: "invalid_metadata" }]);
    }
  },
);

it("always returns an empty warnings array for valid snapshots", () => {
  for (const options of [undefined, { invalidSkills: "warn" as const }]) {
    const result = snapshotPromptResources(
      {
        orbId: "orb",
        commitSha: "a".repeat(40),
        instructionPath: null,
        skillRoot: null,
        files: [],
      },
      options,
    );
    expect(result.isOk() && result.value.warnings).toEqual([]);
  }
});

it("bounds and JSON-escapes fatal diagnostic paths", () => {
  const path = 'AGENTS\n"\\' + "x".repeat(2048);
  const snapshot: ResourceSnapshot = {
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: path,
    skillRoot: null,
    files: [],
  };
  const result = snapshotPromptResources(snapshot, { invalidSkills: "warn" });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      `Required instruction resource missing: ${JSON.stringify(path.slice(0, 1024))}`,
    );
  }
});
