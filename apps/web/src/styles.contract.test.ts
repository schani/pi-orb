import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

it("renders reasoning Markdown without inheriting literal pre-wrap whitespace", () => {
  expect(rule(".reasoning-body > .chat-markdown")).toContain("white-space: normal");
});

it("uses the error signal for activity headline failure and manual Retry", () => {
  expect(rule(".error-text")).toContain("color: var(--bad)");
  const retry = rule("button.text-action.error-text");
  expect(retry).toContain("color: var(--bad)");
  expect(retry).toContain("border-bottom-color: var(--bad)");
  expect(retry).toContain("background: transparent");
});

describe("orb alerts", () => {
  it("keeps long plain text inside a phone-width reverse band without coloring the orb row", () => {
    const band = rule(".alert-band");
    expect(css).toMatch(/(?:^|\n)\.rec-alert \{\s*padding: 4px 0;/);
    expect(band).toContain("padding: 10px 12px");
    expect(band).toContain("background: #b21f2d");
    expect(band).toContain("color: #fff");
    expect(band).toContain("white-space: pre-wrap");
    expect(band).toContain("overflow-wrap: anywhere");
    expect(rule(".orb-entry-alert")).not.toContain("background");
    expect(rule(".rec-bd")).toContain("min-width: 0");
  });
});

describe("subagent roster", () => {
  it("has no nested disclosure-marker or identity-only styles", () => {
    expect(css).not.toMatch(/\.subagent-roster[^{}]*::before/);
    expect(css).not.toContain(".subagent-roster .subagent-identity");
    expect(rule(".subagent-roster > li")).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });
});

describe("composer typography", () => {
  it("inherits the transcript face with zoom-safe phone and touch input sizes", () => {
    expect(rule("body")).toContain("font-family: var(--text)");
    expect(rule("body")).toContain("font-size: var(--text-size)");
    expect(rule(":root")).toContain("--text-size: 13px");
    expect(rule("button,\ninput,\ntextarea,\nselect")).toContain("font: inherit");
    const composerRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      selector?.includes(".composer"),
    );
    for (const [, selector, declarations] of composerRules) {
      expect(declarations, selector).not.toMatch(/font(?:-family)?\s*:/);
    }
    expect(css).toMatch(
      /@media \(max-width: 600px\), \(any-pointer: coarse\)\s*\{\s*input,\s*textarea,\s*select,\s*\.composer-caret-mirror,\s*\.composer-caret\s*\{\s*font-size: 16px;/,
    );
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain("width=device-width, initial-scale=1");
    expect(html).not.toMatch(/user-scalable|maximum-scale|minimum-scale/);
  });
});

describe("bundled typography", () => {
  it("separates quasi-proportional reading text from fixed-cell code", () => {
    expect(rule(":root")).toContain('--text: "Iosevka Etoile"');
    expect(rule(":root")).toContain('--mono: "JetBrains Mono"');
    expect(rule("body")).toContain('font-feature-settings: "calt" 1');
    expect(rule("code,\npre,\n.tool-output")).toContain("font-family: var(--mono)");
    expect(rule(".orb-terminal-emulator")).toContain("--term-font-family: var(--mono)");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)];
    expect(faces).toHaveLength(6);
    for (const [, face] of faces) {
      const path = /url\("([^"]+)"\)/.exec(face ?? "")?.[1];
      expect(path).toMatch(/^\/fonts\/.+\.woff2$/);
      expect(
        readFileSync(new URL(`../public${path}`, import.meta.url))
          .subarray(0, 4)
          .toString(),
      ).toBe("wOF2");
    }
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
  it("uses icon-only creation without a bottom text action", () => {
    expect(css).not.toContain(".project-new-orb-row");
    expect(rule(".project-name")).toContain("min-width: 0");
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.project-head-actions > \.icon-button \{[^}]*width: 48px/,
    );
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

  it("fills available width whenever two fixed columns cannot fit", () => {
    expect(css).toMatch(
      /@media \(width < 632px\)\s*\{\s*\.dashboard\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
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

  it("keeps every dashboard orb entry on its line grid behind its state hue", () => {
    expect(rule(".orb-entry")).toContain("border-left: 2px solid var(--g2)");
    expect(rule(".orb-entry-del")).toContain("border-left-style: dotted");
    expect(rule(".orb-entry-title")).toContain("height: 22px");
    expect(rule(".orb-entry-title")).toContain("align-items: center");
    expect(rule(".orb-entry-link")).toContain("white-space: nowrap");
    expect(rule(".orb-entry-meta")).toContain("height: var(--row)");
    expect(rule(".orb-entry-error")).toContain("color: var(--bad)");
  });

  it("uses the stopped gray hue for sleeping rows without overriding selected fill", () => {
    expect(rule(".s-sleep")).toContain("color: var(--st-stop)");
    expect(rule(".orb-entry-sleep")).toContain("border-left-color: var(--st-stop)");
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
    expect(rule(".rec-you,\n.rec-orb,\n.rec-alert")).toContain("display: block");
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
    expect(rule(".app:has(.orb-page)")).toContain("height: 100dvh");
    expect(rule(".orb-page")).toContain("flex: 1");
    expect(rule(".orb-page")).toContain("min-height: 0");
    expect(rule(".orb-main")).toContain("overflow: hidden");
    expect(rule(".orb-header-stack")).toContain("flex: 0 1 auto");
    expect(rule(".orb-header-scroll")).toContain("overflow-y: auto");
    expect(rule(".orb-transcript-scroll")).toContain("overflow: auto");
    expect(rule(".orb-transcript-scroll")).toContain("min-height: 40px");
    expect(rule(".orb-page")).toContain("grid-template-columns: 236px minmax(0, 1fr)");
    expect(rule(".orb-transcript-content > .history")).toContain("flex: 1 0 auto");
    expect(rule(".composer")).toContain("position: sticky");
    expect(rule(".composer")).toContain("z-index: 30");
    expect(rule(".composer")).toContain("bottom: 0");
  });

  it("keeps the project index beside the transcript with plain hover rows", () => {
    expect(rule(".orb-index")).toContain("position: fixed");
    expect(rule(".orb-index")).toContain("width: 236px");
    expect(rule(".orb-index")).toContain("overflow-y: auto");
    expect(rule(".orb-main")).toContain("grid-column: 2");
    expect(rule(".app:has(> .session-ribbon) .orb-index")).toContain("top: var(--ribbon)");
    expect(rule(".app:has(> .session-ribbon) .orb-index")).toContain(
      "height: calc(100dvh - var(--ribbon))",
    );
    const phone = css.slice(css.indexOf("@media (max-width: 600px)"));
    expect(phone).toMatch(/\.orb-main \{\s*grid-column: 1;/);
    expect(phone).toMatch(/\.orb-index \{\s*display: none;/);
    expect(rule(".orb-index")).toContain("border-right: 1px solid var(--k)");
    const row = rule(".ix-row");
    expect(row).toContain("grid-template-columns: 16px minmax(0, 1fr) auto");
    expect(row).not.toContain("border-left");
    const hover = rule(".ix-row:hover");
    expect(hover).toContain("background: var(--g1)");
    expect(hover).toContain("border-bottom-color: var(--g1)");
    const current = rule(".ix-row-current,\n.ix-row-current:hover");
    expect(current).toContain("background: var(--k)");
    expect(current).toContain("border-bottom-color: var(--k)");
  });

  it("keeps stacked project actions and headers on the existing grid", () => {
    expect(rule(".orb-index .project-head-actions")).toContain("margin-left: auto");
    expect(rule(".orb-index .project-head-actions")).toContain("gap: 4px");
    expect(rule("a.project-new-orb-icon")).toContain("width: 24px");
    expect(rule("a.project-new-orb-icon")).toContain("height: 24px");
    expect(rule(".ix-project > .project-head")).toContain("top: 24px");
    expect(rule(".ix-project + .ix-project")).toContain("border-top: 1px solid var(--k)");
  });

  it("retains the diagnostic gutter and keeps queue state visible", () => {
    expect(rule(".rec")).toContain("grid-template-columns: 32px minmax(0, 1fr)");
    expect(rule(".rec-you,\n.rec-orb,\n.rec-alert")).toContain("display: block");
    expect(rule(".busy-indicator")).toContain("padding: 0 12px");
    expect(rule(".rec-q")).toContain("border-left: 2px dotted var(--w)");
    expect(rule(".rec-status")).toContain("border: 1px solid currentcolor");
  });

  it("overlays a full-width headerless terminal below the header and active-child rail", () => {
    expect(rule(".orb-header-stack")).toContain("position: relative");
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
    expect(rule(".rec-orb > .rec-bd > .activity-rail-row")).toContain("border: 0");
    expect(rule(".rec-orb > .rec-bd > .activity-rail-row::before")).toContain(
      "background: var(--g2)",
    );
    expect(
      rule(".rec-orb > .rec-bd > .activity-rail-row > summary .activity-rail-marker"),
    ).toContain("background: var(--w)");
    expect(
      rule(
        ".rec-orb > .rec-bd > .activity-rail-row > .reasoning-body,\n.rec-orb > .rec-bd > .activity-rail-row > .tool-activity-calls,\n.rec-orb > .rec-bd > .activity-rail-row > .subagent-notice-body",
      ),
    ).toContain("border-top: 0");
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

  it("balances isolated activity rows with prose without separating adjacent rail rows", () => {
    expect(rule(".activity-rail-row")).toContain("margin-bottom: 4px");
    expect(rule(".rec-orb > .rec-bd > .response-markdown + .activity-rail-row")).toContain(
      "margin-top: 4px",
    );
    expect(rule(".chat-markdown > :last-child")).toContain("margin-bottom: 0");
  });

  it("indents expanded subagent receipts, including errors, past the rail on desktop and phones", () => {
    const receipt = /(?:^|\n)\.subagent-notice-body\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(receipt).toBeDefined();
    expect(receipt).toContain("overflow-wrap: anywhere");
    expect(receipt).toContain("background: var(--g1)");
    const railBodies = rule(
      ".rec-orb > .rec-bd > .activity-rail-row > .reasoning-body,\n.rec-orb > .rec-bd > .activity-rail-row > .tool-activity-calls,\n.rec-orb > .rec-bd > .activity-rail-row > .subagent-notice-body",
    );
    expect(railBodies).toContain("padding-left: calc(2ch + 16px)");
    expect(railBodies).toContain("border-top: 0");
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
