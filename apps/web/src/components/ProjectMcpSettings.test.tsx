import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectMcpSettings } from "./ProjectMcpSettings.tsx";

it("offers project-scoped MCP configuration without OAuth or credential entry", () => {
  const html = renderToStaticMarkup(
    <ProjectMcpSettings
      projectId="project"
      projectName="Atlas"
      saving={false}
      setSaving={() => {}}
    />,
  );
  expect(html).not.toContain('role="dialog"');
  expect(html).toContain("&quot;secret&quot;: &quot;TOKEN&quot;");
  expect(html).toContain("&quot;prefix&quot;: &quot;Bearer &quot;");
  expect(html).toContain("Description");
  expect(html).toContain("project-mcp-form");
  expect(html).not.toContain("OAuth");
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain('data-1p-ignore="true"');
});
