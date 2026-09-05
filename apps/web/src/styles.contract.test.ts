import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("dashboard layout contract", () => {
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
    expect(rule(".orb-entry-del")).toContain("border-left-style: dotted");
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
  it("carries viewport height through the app to the bottom-pinned composer", () => {
    expect(rule(".app")).toContain("display: flex");
    expect(rule(".app")).toContain("min-height: 100dvh");
    expect(rule(".app")).toContain("flex-direction: column");
    expect(rule(".orb-page")).toContain("flex: 1");
    expect(rule(".orb-page")).toContain("grid-template-columns: 236px minmax(0, 1fr)");
    expect(rule(".orb-main > .history")).toContain("flex: 1 0 auto");
    expect(rule(".composer")).toContain("position: sticky");
    expect(rule(".composer")).toContain("z-index: 30");
    expect(rule(".composer")).toContain("bottom: 0");
  });

  it("keeps the project index beside the transcript at full viewport height", () => {
    expect(rule(".orb-index")).toContain("position: sticky");
    expect(rule(".orb-index")).toContain("max-height: 100dvh");
    expect(rule(".orb-index")).toContain("border-right: 1px solid var(--k)");
    expect(rule(".ix-row")).toContain("grid-template-columns: 1.6ch minmax(0, 1fr) auto");
    expect(rule(".ix-row")).toContain("border-left: 2px solid var(--g2)");
    expect(rule(".ix-row-current,\n.ix-row-current:hover")).toContain("background: var(--k)");
  });

  it("spans the user band across the record's prefix column", () => {
    expect(rule(".rec")).toContain("grid-template-columns: 32px minmax(0, 1fr)");
    expect(rule(".rec-you")).toContain("background: var(--g1)");
    expect(rule(".rec-you")).toContain("border-top: 1px solid var(--g2)");
    expect(rule(".rec-you")).toContain("border-bottom: 1px solid var(--g2)");
    expect(rule(".rec-q")).toContain("border-left: 2px dotted var(--g2)");
  });

  it("stacks the terminal title bar above the emulator", () => {
    expect(rule(".orb-terminal-window")).toContain("display: flex");
    expect(rule(".orb-terminal-window")).toContain("flex-direction: column");
    expect(rule(".orb-terminal-header")).toContain("flex: 0 0 20px");
    expect(rule(".orb-terminal-header")).toContain("background: var(--k)");
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
