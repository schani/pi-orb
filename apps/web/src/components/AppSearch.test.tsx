import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppSearchSource } from "../lib/app-search.ts";
import { AppSearchDialog } from "./AppSearch.tsx";

const source: AppSearchSource = {
  id: "fixture",
  label: "Find fixture resources",
  placeholder: "Find something",
  scopeDescription: "Fixture names",
  status: { type: "complete" },
  items: [
    {
      key: "fixture:item",
      kindLabel: "orb",
      title: "Compiler repair",
      context: "Atlas · working set",
      keywords: ["Compiler repair"],
      href: "#/orbs/orb-1",
    },
    {
      key: "fixture:item-2",
      kindLabel: "orb",
      title: "Compiler redesign",
      context: "Atlas · working set",
      keywords: ["Compiler redesign"],
      href: "#/orbs/orb-2",
    },
  ],
};

const noop = () => {};

function render(query: string, activeKey = "fixture:item"): string {
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
    expect(html).toContain('<a id="app-search-result-0"');
    expect(html).toContain('href="#/orbs/orb-1"');
    expect(html).toContain('href="#/orbs/orb-2"');
    expect(html.match(/app-search-result active/g)).toHaveLength(1);
    expect(html).not.toContain('role="link"');
  });

  it("keeps empty-query scope guidance and an accessible search input", () => {
    const html = render("");
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Find fixture resources"');
    expect(html).toContain('class="app-search-result-region"');
    expect(html).toContain("Fixture names");
  });
});
