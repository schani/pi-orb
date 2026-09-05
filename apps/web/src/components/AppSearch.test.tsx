import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppSearchSource } from "../lib/app-search.ts";
import { AppSearchDialog } from "./AppSearch.tsx";

const source: AppSearchSource = {
  id: "fixture",
  label: "Find fixture resources",
  status: { type: "complete" },
  items: [
    {
      key: "fixture:project",
      kindLabel: "project",
      group: "projects",
      title: "Compiler",
      context: "https://github.com/acme/compiler",
      keywords: ["Compiler"],
      href: "#/projects/project-1",
    },
    {
      key: "fixture:orb",
      kindLabel: "orb",
      group: "orbs",
      title: "Compiler repair",
      context: "Atlas · working set",
      glyph: { char: "●", state: "busy", label: "busy" },
      chip: "Atlas",
      age: "2m",
      keywords: ["Compiler repair"],
      href: "#/orbs/orb-1",
    },
    {
      key: "fixture:orb-2",
      kindLabel: "orb",
      group: "orbs",
      title: "Compiler redesign",
      context: "Atlas · working set",
      glyph: { char: "–", state: "stop", label: "stopped" },
      chip: "Atlas",
      age: "3d",
      keywords: ["Compiler redesign"],
      href: "#/orbs/orb-2",
    },
  ],
};

const noop = () => {};

function render(query: string, activeKey = "fixture:orb"): string {
  return renderToStaticMarkup(
    <AppSearchDialog
      source={source}
      query={query}
      activeKey={activeKey}
      onQueryChange={noop}
      onActiveKeyChange={noop}
      onClose={noop}
    />,
  );
}

describe("AppSearchDialog", () => {
  it("renders every matching result as a native link with exactly one selection", () => {
    const html = render("compiler", "no-longer-present");
    expect(html).toContain('href="#/orbs/orb-1"');
    expect(html).toContain('href="#/orbs/orb-2"');
    expect(html).toContain('href="#/projects/project-1"');
    expect(html.match(/app-search-result active/g)).toHaveLength(1);
    expect(html).not.toContain('role="link"');
  });

  it("groups matches under headings in source group order", () => {
    const html = render("compiler", "no-longer-present");
    expect(html.indexOf('class="app-search-group">projects')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('class="app-search-group">projects')).toBeLessThan(
      html.indexOf('class="app-search-group">orbs'),
    );
    expect(html.indexOf('href="#/projects/project-1"')).toBeLessThan(
      html.indexOf('href="#/orbs/orb-1"'),
    );
    // Keyboard order follows the display order: the first row is the default selection.
    expect(html).toContain('id="app-search-result-0" class="app-search-result active"');
  });

  it("shows the state glyph, owning project, and age on one orb row", () => {
    const html = render("repair");
    expect(html).toContain('class="glyph s-busy"');
    expect(html).toContain('class="app-search-chip">Atlas');
    expect(html).toContain('class="app-search-age">2m');
    expect(html).toContain("<mark>repair</mark>");
  });

  it("says nothing before a query and reports an empty result set", () => {
    expect(render("")).not.toContain("app-search-result ");
    expect(render("")).not.toContain("app-search-group");
    expect(render("")).not.toContain("app-search-empty");
    expect(render("nothing matches this")).toContain("no match");
  });

  it("keeps an accessible search input", () => {
    const html = render("");
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Find fixture resources"');
    expect(html).toContain('class="app-search-result-region"');
  });
});
