import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConfigTabs } from "./ConfigTabs.tsx";

it("shares project and owner tab semantics with one roving focus target", () => {
  const html = renderToStaticMarkup(
    <ConfigTabs
      id="owner-settings"
      label="Settings"
      names={["Instructions", "Claude"]}
      selected={1}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain('class="project-config-tabs"');
  expect(html).toContain('role="tablist" aria-label="Settings"');
  expect(html).toContain(
    'id="owner-settings-tab-0" aria-controls="owner-settings-panel-0" aria-selected="false" tabindex="-1"',
  );
  expect(html).toContain(
    'id="owner-settings-tab-1" aria-controls="owner-settings-panel-1" aria-selected="true" tabindex="0"',
  );
});
