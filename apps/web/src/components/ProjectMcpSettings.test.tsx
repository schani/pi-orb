import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { McpEditor, ProjectMcpSettings } from "./ProjectMcpSettings.tsx";

it("does not render an always-open creation form", () => {
  const html = renderToStaticMarkup(
    <ProjectMcpSettings
      projectId="project"
      projectName="Atlas"
      saving={false}
      setSaving={() => {}}
    />,
  );
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("Header bindings");
  expect(html).not.toContain("<form");
});
it("uses name-first compact ledger with OAuth or a bearer secret, not raw headers", () => {
  const html = renderToStaticMarkup(
    <McpEditor
      saving={false}
      secrets={[]}
      refreshSecrets={() => {}}
      onSave={async () => {}}
      onCancel={() => {}}
    />,
  );
  expect(html.indexOf(">Name<")).toBeLessThan(html.indexOf(">Endpoint<"));
  expect(html).toContain("OAuth");
  expect(html).toContain("Bearer token");
  expect(html).not.toContain("Advanced");
  expect(html).not.toContain("Header bindings");
  expect(html).not.toContain("Description");
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain('data-1p-ignore="true"');
});
