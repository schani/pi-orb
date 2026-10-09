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
