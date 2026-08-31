import type { ProjectView } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSecretsModal } from "./ProjectSecretsModal.tsx";

const project: ProjectView = {
  id: "project-1",
  name: "Atlas",
  repositoryUrl: "https://github.com/acme/atlas",
  state: "active",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("ProjectSecretsModal", () => {
  it("renders the selected Sealed-card write-only contract", () => {
    const html = renderToStaticMarkup(<ProjectSecretsModal project={project} onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Secrets for Atlas");
    expect(html).toContain("next start");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("reveal");
    expect(html).not.toContain("show value");
  });

  it("does not make the backdrop an accidental close button", () => {
    const html = renderToStaticMarkup(<ProjectSecretsModal project={project} onClose={() => {}} />);
    expect(html).toContain('class="project-secrets-backdrop"');
    expect(html).not.toContain('class="project-secrets-backdrop" role="button"');
  });
});
