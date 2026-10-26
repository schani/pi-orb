import type { OwnerSkill } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  NEW_SKILL,
  type OwnerSkills,
  OwnerSkillsPane,
  savedSkillName,
} from "./OwnerSkillsSettings.tsx";

const skill = (name: string, description: string): OwnerSkill => ({
  name,
  description,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n`,
  updatedAt: "2026-10-26T00:00:00.000Z",
});
const items = [skill("pg-migrations", "Safe migrations."), skill("release-notes", "Notes.")];
const noop = () => {};
const state = (overrides: Partial<OwnerSkills> = {}): OwnerSkills => ({
  items,
  drafts: {},
  open: null,
  adding: false,
  loading: false,
  saving: false,
  error: null,
  status: null,
  writePending: { current: false },
  load: async () => {},
  cancel: noop,
  edit: noop,
  toggle: noop,
  startAdding: noop,
  cancelAdding: noop,
  save: async () => {},
  remove: async () => false,
  ...overrides,
});

it("renders each skill as an MCP-style disclosure over its raw SKILL.md", () => {
  const html = renderToStaticMarkup(<OwnerSkillsPane skills={state({ open: "release-notes" })} />);
  expect(html.match(/<details class="activity-rail-row project-mcp-connection"/g)).toHaveLength(2);
  expect(html).toContain(
    '<span class="activity-rail-summary">pg-migrations<span class="activity-rail-headline"> · Safe migrations.</span></span>',
  );
  expect(html.match(/<details[^>]* open=""/g)).toHaveLength(1);
  expect(html).toMatch(
    /<div class="reasoning-body"><form class="project-instructions-editor skill-editor"><span class="text-field-frame"><textarea aria-label="SKILL.md"/,
  );
  expect(html.match(/<button type="button" class="danger">remove<\/button>/g)).toHaveLength(2);
  expect(html.match(/<button type="submit" disabled="">Save<\/button>/g)).toHaveLength(2);
  expect(html).toContain(
    '<div class="mcp-add-area"><button type="button" class="text-action">add skill</button></div>',
  );
  expect(html).not.toContain("Saved");
  expect(html).not.toContain("new skill");
});

it("enables Save only for a dirty draft and reports the row outcome in that row", () => {
  const html = renderToStaticMarkup(
    <OwnerSkillsPane
      skills={state({
        drafts: { "release-notes": "edited" },
        status: { key: "release-notes", error: "invalid_request: description required" },
      })}
    />,
  );
  const [pg, release] = html.split("<details").slice(1);
  expect(pg).not.toContain('role="alert"');
  expect(pg).toContain('<button type="submit" disabled="">Save</button>');
  expect(release).toContain(">edited</textarea>");
  expect(release).toContain(
    '<span role="alert" class="personal-instructions-error">invalid_request: description required</span>',
  );
  expect(release).toContain('<button type="submit">Save</button>');
  const saved = renderToStaticMarkup(
    <OwnerSkillsPane skills={state({ status: { key: "pg-migrations", error: null } })} />,
  );
  expect(saved.match(/Saved · next orb start/g)).toHaveLength(1);
  expect(saved.split("<details")[1]).toContain("Saved · next orb start");
});

it("replaces the add action with an open empty new-skill disclosure", () => {
  const html = renderToStaticMarkup(
    <OwnerSkillsPane skills={state({ adding: true, open: NEW_SKILL })} />,
  );
  expect(html).not.toContain("add skill");
  const fresh = html.split("<details").at(-1) ?? "";
  expect(fresh).toMatch(/^ class="activity-rail-row project-mcp-connection"[^>]* open=""/);
  expect(fresh).toContain('<span class="activity-rail-summary">new skill</span>');
  expect(fresh).toContain("></textarea>");
  expect(fresh).toContain('<button type="button">cancel</button>');
  expect(fresh).not.toContain("remove");
  expect(fresh).toContain('<button type="submit" disabled="">Save</button>');
});

it("disables every skill control while a save owns the dialog", () => {
  const html = renderToStaticMarkup(
    <OwnerSkillsPane skills={state({ saving: true, open: "pg-migrations" })} />,
  );
  expect(html).not.toMatch(/<(button|textarea)(?![^>]*disabled="")[^>]*>/);
  expect(html.match(/<summary aria-disabled="true"/g)).toHaveLength(2);
});

it("names the saved skill from the returned list, including creates and renames", () => {
  const renamed = [skill("changelog", "Notes."), items[0] as OwnerSkill];
  expect(savedSkillName(items, renamed, "release-notes")).toBe("changelog");
  expect(savedSkillName(items, [...items, skill("zz", "New.")], NEW_SKILL)).toBe("zz");
  expect(savedSkillName(items, items, "release-notes")).toBe("release-notes");
});
