import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CreateOrbPage } from "./CreateOrbPage.tsx";

it("creates directly without a second harness choice or submit button", () => {
  const html = renderToStaticMarkup(<CreateOrbPage projectId="project" />);
  expect(html).not.toContain('aria-label="Harness"');
  expect(html).not.toContain("Create orb");
  expect(html).toContain("creating orb…");
});
