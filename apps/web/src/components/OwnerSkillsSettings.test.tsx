import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OwnerSkillsPane, useOwnerSkills } from "./OwnerSkillsSettings.tsx";

function Draft() {
  const skills = useOwnerSkills({ current: null });
  return (
    <OwnerSkillsPane skills={{ ...skills, items: [], drafts: { "+new": "" }, open: "+new" }} />
  );
}

it("offers manual-first source selection only in the new-skill disclosure", () => {
  const html = renderToStaticMarkup(<Draft />);
  expect(html).toContain('aria-label="Draft source"');
  expect(html).toContain('<option value="manual" selected="">SKILL.md</option>');
  expect(html).toContain('<option value="github">GitHub URL</option>');
  expect(html).toContain('aria-label="SKILL.md"');
  expect(html).not.toContain('aria-label="GitHub URL"');
});

function Imported() {
  const skills = useOwnerSkills({ current: null });
  const item = {
    name: "handbook",
    description: "Write manuals.",
    content: "root",
    updatedAt: "2026-10-27T00:00:00Z",
    source: { url: "https://github.com/o/r/tree/main/skill", commitSha: "a".repeat(40) },
    fileCount: 3,
    totalBytes: 129,
  };
  return <OwnerSkillsPane skills={{ ...skills, items: [item], open: item.name }} />;
}

it("labels provenance as import origin alongside the raw editor and lightweight totals", () => {
  const html = renderToStaticMarkup(<Imported />);
  expect(html).toContain("Import origin");
  expect(html).toContain("a".repeat(40));
  expect(html).toContain("3 files · 129 bytes");
  expect(html).toContain('aria-label="SKILL.md"');
  expect(html).not.toContain('aria-label="Draft source"');
  expect(html).not.toContain("base64");
});
