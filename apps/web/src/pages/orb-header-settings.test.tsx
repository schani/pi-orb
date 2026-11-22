import type { AgentSettingsEvent } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OrbHeaderSettings } from "./OrbPage.tsx";

const settings: AgentSettingsEvent = {
  type: "agent_settings",
  settings: { model: { provider: "claude", id: "opus" }, thinkingLevel: "high" },
  models: [{ provider: "claude", id: "opus", name: "Opus", thinkingLevels: ["low", "high"] }],
  writable: true,
};
const render = (view: AgentSettingsEvent | null, effortLabel: "effort" | "thinking" = "effort") =>
  renderToStaticMarkup(
    <OrbHeaderSettings view={view} pending={false} effortLabel={effortLabel} onOpen={() => {}} />,
  );

it("renders nothing without current live settings", () => {
  expect(render(null)).toBe("");
});
it("shows the known model and advertised effort", () => {
  const html = render(settings);
  expect(html).toContain('aria-label="Change model"');
  expect(html).toContain(">Opus</button>");
  expect(html).toContain('aria-label="Change effort"');
  expect(html).toContain(">high</button>");
});
it("omits effort for a Claude model without native effort levels", () => {
  const html = render({
    ...settings,
    settings: { model: { provider: "claude", id: "haiku" }, thinkingLevel: "off" },
    models: [{ provider: "claude", id: "haiku", name: "Haiku", thinkingLevels: [] }],
  });
  expect(html).toContain(">Haiku</button>");
  expect(html).not.toContain('aria-label="Change effort"');
  expect(html).not.toContain(">off</button>");
});
it("does not infer Claude effort support for an unadvertised model", () => {
  const html = render({ ...settings, models: [] });
  expect(html).toContain(">opus</button>");
  expect(html).not.toContain('aria-label="Change effort"');
});
it("preserves Pi thinking controls including off", () => {
  const html = render(
    {
      ...settings,
      settings: { model: { provider: "test", id: "pi" }, thinkingLevel: "off" },
      models: [{ provider: "test", id: "pi", name: "Pi model", thinkingLevels: ["off", "high"] }],
    },
    "thinking",
  );
  expect(html).toContain('aria-label="Change thinking"');
  expect(html).toContain(">off</button>");
});
it("disables known controls while a request is pending", () => {
  const html = renderToStaticMarkup(
    <OrbHeaderSettings view={settings} pending effortLabel="effort" onOpen={() => {}} />,
  );
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});
