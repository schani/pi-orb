import type { ProjectView } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectGeneralSettings } from "./ProjectGeneralSettings.tsx";

const project: ProjectView = {
  id: "name-only",
  name: "Notebook",
  repositoryUrl: null,
  state: "active",
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
};

it.each([null, "", "   "])("allows saving a name-only project (%s)", (repositoryUrl) => {
  const html = renderToStaticMarkup(
    <ProjectGeneralSettings
      project={{ ...project, repositoryUrl }}
      saving={false}
      setSaving={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(html).toContain('value="Notebook"');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('aria-invalid="true"');
  expect(html).not.toMatch(/<button[^>]*disabled/);
  expect(html.match(/required=""/g)).toHaveLength(1);
});

it("rejects malformed nonblank repository URLs", () => {
  const html = renderToStaticMarkup(
    <ProjectGeneralSettings
      project={{ ...project, repositoryUrl: "https://evil.test/o/r" }}
      saving={false}
      setSaving={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toMatch(/<button[^>]*disabled/);
});
