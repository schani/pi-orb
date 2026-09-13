import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("shared text selection", () => {
  it("uses a contrasting neutral highlight on both paper and inverted controls", () => {
    expect(rule("::selection")).toContain("background: var(--g2)");
    expect(rule("::selection")).toContain("color: var(--k)");
  });
});

describe("dashboard layout contract", () => {
  it("uppercases the shared new-orb control", () => {
    expect(rule(".project-new-orb")).toContain("text-transform: uppercase");
  });
  it("lays projects out as fixed-width columns that fill rows from the left", () => {
    expect(rule(".dashboard")).toContain("grid-template-columns: repeat(auto-fill, 316px)");
    expect(rule(".dashboard")).toContain("grid-auto-rows: minmax(min-content, 1fr)");
    expect(rule(".dashboard")).toContain("align-content: stretch");
    expect(rule(".dashboard")).toContain("justify-content: start");
    expect(rule(".project-column")).toContain("border-left: 1px solid var(--k)");
    expect(rule(".project-column")).toContain("border-bottom: 1px solid var(--k)");
    expect(rule(".new-project")).toContain("border-left: 1px dashed var(--k)");
  });

  it("rules the board from the totals strip to the bottom-pinned footer", () => {
    // 24px + 24px of chrome, so a one-orb column still draws full-height rules.
    expect(rule(".dashboard")).toContain("min-height: calc(100dvh - 48px)");
    expect(rule(".dashboard-totals")).toContain("height: 24px");
    expect(rule(".dashboard-totals")).toContain("border-bottom: 1px solid var(--k)");
    expect(rule(".dashboard-total")).toContain("border-right: 1px solid var(--k)");
    expect(rule(".dashboard-footer")).toContain("position: sticky");
    expect(rule(".dashboard-footer")).toContain("bottom: 0");
    expect(rule(".dashboard-footer")).toContain("height: 24px");
    expect(rule(".dashboard-footer")).toContain("border-top: 1px solid var(--k)");
  });

  it("gives the project name 18px and the orb name 14px on their own lines", () => {
    expect(rule(".project-head-name")).toContain("height: 24px");
    expect(rule(".project-name")).toContain("font-size: 18px");
    expect(rule(".project-name")).toContain("line-height: 24px");
    expect(rule(".new-project h2")).toContain("font-size: 18px");
    expect(rule(".orb-entry-link")).toContain("font-size: 14px");
    expect(rule(".orb-entry-link")).toContain("line-height: 22px");
  });

  it("keeps every orb entry on its line grid behind its state hue", () => {
    expect(rule(".orb-entry")).toContain("border-left: 2px solid var(--g2)");
    expect(rule(".orb-entry-del,\n.ix-row-del")).toContain("border-left-style: dotted");
    expect(rule(".orb-entry-title")).toContain("height: 22px");
    expect(rule(".orb-entry-meta")).toContain("height: var(--row)");
    expect(rule(".orb-entry-error")).toContain("color: var(--bad)");
  });

  it("inverts the selected find row and underlines the matched text", () => {
    expect(rule(".app-search-result")).toContain("height: var(--row)");
    expect(rule(".app-search-result.active")).toContain("background: var(--k)");
    expect(rule(".app-search-result.active")).toContain("color: var(--w)");
    expect(rule(".app-search-result mark")).toContain("text-decoration: underline");
  });
});

describe("orb workspace layout contract", () => {
  it("scrolls wide tables instead of breaking words to squeeze columns", () => {
    expect(rule(".markdown-table-scroll")).toContain("overflow-x: auto");
    expect(rule(".markdown-table-scroll")).toContain("max-width: 100%");
    const table = rule(".markdown-table-scroll table");
    expect(table).toContain("overflow-wrap: normal");
    expect(table).toContain("word-break: normal");
    expect(table).toContain("white-space: normal");
    expect(rule(".markdown-table-scroll :is(th, td)")).toContain("vertical-align: top");
  });

  it("gives boxed code and text the same gray background as inline code", () => {
    expect(rule(".chat-markdown :not(pre) > code")).toContain("background: var(--g1)");
    expect(rule(".markdown-code-block")).toContain("background: var(--g1)");
    expect(rule(".chat-markdown pre code")).toContain("background: none");
  });

  it("carries viewport height through the app to the bottom-pinned composer", () => {
    expect(rule(".app")).toContain("display: flex");
    expect(rule(".app")).toContain("min-height: 100dvh");
    expect(rule(".app")).toContain("flex-direction: column");
    expect(rule(".orb-page")).toContain("flex: 1");
    expect(rule(".orb-page")).toContain("grid-template-columns: 236px minmax(0, 1fr)");
    expect(rule(".orb-transcript-content > .history")).toContain("flex: 1 0 auto");
    expect(rule(".composer")).toContain("position: sticky");
    expect(rule(".composer")).toContain("z-index: 30");
    expect(rule(".composer")).toContain("bottom: 0");
  });

  it("keeps the project index beside the transcript at full viewport height", () => {
    expect(rule(".orb-index")).toContain("position: sticky");
    expect(rule(".orb-index")).toContain("max-height: 100dvh");
    expect(rule(".orb-index")).toContain("border-right: 1px solid var(--k)");
    expect(rule(".ix-row")).toContain("grid-template-columns: 16px minmax(0, 1fr) auto");
    expect(rule(".ix-row")).toContain("border-left: 2px solid var(--g2)");
    expect(rule(".ix-row-current,\n.ix-row-current:hover")).toContain("background: var(--k)");
  });

  it("keeps stacked project actions and headers on the existing grid", () => {
    expect(rule(".orb-index .project-head-actions")).toContain("margin-left: auto");
    expect(rule(".orb-index .project-head-actions")).toContain("gap: 4px");
    expect(rule("a.project-new-orb-icon")).toContain("width: 24px");
    expect(rule("a.project-new-orb-icon")).toContain("height: 24px");
    expect(rule(".ix-project > .project-head")).toContain("top: 24px");
    expect(rule(".ix-project + .ix-project")).toContain("border-top: 1px solid var(--k)");
  });

  it("spans the user band across the record's prefix column", () => {
    expect(rule(".rec")).toContain("grid-template-columns: 32px minmax(0, 1fr)");
    expect(rule(".rec-you")).toContain("background: var(--g1)");
    expect(rule(".rec-you")).toContain("border-top: 1px solid var(--g2)");
    expect(rule(".rec-you")).toContain("border-bottom: 1px solid var(--g2)");
    expect(rule(".rec-q")).toContain("border-left: 2px dotted var(--g2)");
  });

  it("overlays a full-width headerless terminal immediately below the orb header", () => {
    const terminal = rule(".orb-terminal-window");
    expect(terminal).toContain("position: absolute");
    expect(terminal).toContain("top: 100%");
    expect(terminal).toContain("left: -1px");
    expect(terminal).toContain("width: calc(100% + 1px)");
    expect(terminal).toContain("border: 1px solid var(--k)");
    expect(rule(".orb-terminal-resize")).toContain("bottom: 0");
    expect(rule(".orb-terminal-resize")).toContain("cursor: ns-resize");
    expect(rule(".orb-terminal-body")).toContain("overflow: clip");
    expect(terminal).toContain("padding: 13px 0");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain("padding: 0 15px");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain(
      "scroll-snap-type: y mandatory",
    );
    expect(rule(".orb-terminal-emulator .term-row")).toContain("scroll-snap-align: start");
    expect(rule(".orb-terminal-resize:focus-visible")).toContain("background: transparent");
    expect(rule(".orb-terminal-resize:focus-visible")).toContain("outline: 0");
    expect(terminal).not.toMatch(/animation|transition/);
    expect(rule(".orb-terminal-window.orb-terminal-hidden")).toContain("visibility: hidden");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain("flex: none");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain("border-radius: 0");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain("box-shadow: none");
    expect(css).not.toMatch(/orb-terminal-(header|launcher|controls)/);
    expect(rule(".orb-header-actions")).toContain("gap: 8px");
    expect(rule("button.icon-button")).toContain("width: 20px");
  });

  it("uses one rail-row geometry for reasoning and every tool category", () => {
    const railSummary = rule(
      ".activity-rail-row > summary,\n.tool-activity-call:not(details),\n.tool-activity-call > summary",
    );
    expect(railSummary).toContain("grid-template-columns: 2ch minmax(0, 1fr) auto");
    expect(railSummary).toContain("min-height: var(--row)");
    expect(rule(".activity-rail-row")).toContain("border: 1px solid var(--g2)");
    expect(rule(".activity-rail-marker::before")).toContain('content: "\\25b8"');
    expect(rule(".activity-rail-row[open] > summary .activity-rail-marker::before")).toContain(
      'content: "\\25be"',
    );
    expect(rule(".activity-rail-summary")).toContain("text-overflow: ellipsis");
    expect(
      rule(
        ".activity-rail-row-failed .activity-rail-marker,\n.activity-rail-row-failed .activity-rail-label,\n.tool-activity-failed,\n.tool-diff-removed",
      ),
    ).toContain("color: var(--bad)");
    expect(
      rule(
        ".activity-rail-row-running .activity-rail-marker,\n.activity-rail-row-running .activity-rail-label,\n.tool-activity-running,\n.tool-diff-added",
      ),
    ).toContain("color: var(--ok)");
    expect(rule(".reasoning-body,\n.tool-activity-calls")).toContain("background: var(--g1)");
  });
});
