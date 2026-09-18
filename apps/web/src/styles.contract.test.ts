import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("subagent roster", () => {
  it("has no nested disclosure-marker or identity-only styles", () => {
    expect(css).not.toMatch(/\.subagent-roster[^{}]*::before/);
    expect(css).not.toContain(".subagent-roster .subagent-identity");
    expect(rule(".subagent-roster > li")).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });
});

describe("shared text fields", () => {
  it("overlays shared crop marks without changing field spacing", () => {
    const focused = rule("input:focus,\ntextarea:focus");
    expect(focused).toContain("background: var(--w)");
    expect(focused).toContain("color: var(--k)");
    expect(focused).toContain("caret-color: var(--k)");
    const frame = rule(".text-field-frame");
    expect(frame).not.toMatch(/padding|margin/);
    const marks = rule(".text-field-frame:focus-within::after");
    expect(marks).toContain("inset: -3px");
    expect(marks).toContain("pointer-events: none");
    expect(marks.match(/linear-gradient/g)).toHaveLength(8);
    expect(marks.match(/11px 1px/g)).toHaveLength(4);
    expect(marks.match(/1px 11px/g)).toHaveLength(4);
    expect(rule(".text-field-frame-inset:focus-within::after")).toContain("inset: 3px");
    expect(css).not.toContain("text-field-frame-search");
    expect(css).not.toContain("text-field-frame-composer");
    expect(rule(":focus-visible")).toContain("background: var(--k)");
    const exemption = rule(
      ".text-field-frame > input:focus-visible,\n.text-field-frame > textarea:focus-visible",
    );
    expect(exemption).toContain("background: var(--w)");
    expect(exemption).toContain("color: var(--k)");
    expect(
      rule(".personal-instructions-dialog textarea,\n.project-instructions-editor textarea"),
    ).toContain("border: 0");
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.orb-rename-form \{[^}]*flex-wrap: wrap/,
    );
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.orb-rename-form > \.text-field-frame \{[^}]*width: 80px/,
    );
  });

  it("uses a neutral highlight on every paper surface", () => {
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
    expect(rule(".orb-entry-title")).toContain("align-items: center");
    expect(rule(".orb-entry-link")).toContain("white-space: nowrap");
    expect(rule(".orb-entry-meta")).toContain("height: var(--row)");
    expect(rule(".orb-entry-error")).toContain("color: var(--bad)");
  });

  it("uses the stopped gray hue for sleeping rows without overriding selected fill", () => {
    expect(rule(".s-sleep")).toContain("color: var(--st-stop)");
    expect(rule(".orb-entry-sleep,\n.ix-row-sleep")).toContain("border-left-color: var(--st-stop)");
    expect(
      rule(
        ".orb-entry-stop .orb-entry-link,\n.orb-entry-sleep .orb-entry-link,\n.orb-entry-arch .orb-entry-link,\n.orb-entry-archng .orb-entry-link,\n.orb-entry-del .orb-entry-link",
      ),
    ).toContain("color: var(--g3)");
    expect(rule(".ix-row-current,\n.ix-row-current:hover")).toContain("background: var(--k)");
  });

  it("inverts the selected find row and underlines the matched text", () => {
    expect(rule(".app-search-result")).toContain("height: var(--row)");
    expect(rule(".app-search-result.active")).toContain("background: var(--k)");
    expect(rule(".app-search-result.active")).toContain("color: var(--w)");
    expect(rule(".app-search-result mark")).toContain("text-decoration: underline");
  });
});

describe("orb workspace layout contract", () => {
  it("uses gutter-free inverted user paper and plain white orb paper", () => {
    expect(rule(".rec-you,\n.rec-orb")).toContain("display: block");
    const user = rule(".rec-you");
    expect(user).toContain("background: var(--k)");
    expect(user).toContain("color: var(--w)");
    expect(user).toContain("font-weight: 400");
    expect(rule(".rec-you .chat-markdown :not(pre) > code")).toContain("color: var(--k)");
    expect(rule(".rec-you .markdown-code-block")).toContain("background: var(--w)");
    const error = rule(".rec-you .error-text");
    expect(error).toContain("color: var(--bad)");
    expect(error).toContain("background: var(--w)");
  });

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

  it("retains the type gutter only for shell records and keeps queue state visible", () => {
    expect(rule(".rec")).toContain("grid-template-columns: 32px minmax(0, 1fr)");
    expect(rule(".rec-you,\n.rec-orb")).toContain("display: block");
    expect(rule(".rec-q")).toContain("border-left: 2px dotted var(--w)");
    expect(rule(".rec-status")).toContain("border: 1px solid currentcolor");
  });

  it("overlays a full-width headerless terminal below the header and active-child rail", () => {
    expect(rule(".orb-header-stack")).toContain("position: sticky");
    expect(rule(".orb-header")).toContain("position: relative");
    const terminal = rule(".orb-terminal-window");
    expect(terminal).toContain("position: absolute");
    expect(terminal).toContain("top: calc(100% - 1px)");
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

  it("contains inline tool images without cropping and keeps the viewer monochrome", () => {
    const thumbnail = rule(".tool-image-thumbnail");
    expect(thumbnail).toContain("max-width: min(100%, 32rem)");
    expect(thumbnail).toContain("max-height: 22rem");
    expect(thumbnail).toContain("object-fit: contain");
    const preview = rule(".tool-image-preview");
    expect(preview).toContain("min-width: 0");
    expect(preview).toContain("max-width: 100%");
    const trigger = rule(".tool-image-trigger");
    expect(trigger).toContain("width: max-content");
    expect(trigger).toContain("max-width: min(100%, calc(32rem + 2px))");
    expect(trigger).toContain("border: 1px solid var(--k)");
    const dialog = rule(".tool-image-dialog");
    expect(dialog).toContain("width: fit-content");
    expect(dialog).toContain("height: fit-content");
    expect(dialog).toContain("border-radius: 0");
    const full = rule(".tool-image-full");
    expect(full).toContain("width: auto");
    expect(full).toContain("height: auto");
    expect(full).toContain("object-fit: contain");
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.tool-image-dialog-close \{[^}]*width: 44px;[^}]*height: 44px/,
    );
  });
});
