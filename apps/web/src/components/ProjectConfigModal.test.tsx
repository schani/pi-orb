import type { ProjectView } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectConfigModal } from "./ProjectConfigModal.tsx";

const project: ProjectView = {
  id: "project-1",
  name: "Atlas",
  repositoryUrl: null,
  state: "active",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("ProjectConfigModal", () => {
  it("renders the selected Sealed-card write-only contract", () => {
    const html = renderToStaticMarkup(
      <ProjectConfigModal project={project} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(html).toContain("Instructions");
    expect(html).toContain('aria-label="Additional project instructions"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Config for Atlas");
    expect(html).toContain("Repository applies to new checkouts");
    expect(html).toMatch(/<input(?![^>]*required)[^>]*aria-invalid="false"[^>]*value=""/);
    expect(html).toContain('<button type="submit">save</button>');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("reveal");
    expect(html).not.toContain("show value");
  });

  it("renders the backdrop without button semantics", () => {
    const html = renderToStaticMarkup(
      <ProjectConfigModal project={project} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).toContain('class="project-secrets-backdrop"');
    expect(html).not.toContain('class="project-secrets-backdrop" role="button"');
  });
});
