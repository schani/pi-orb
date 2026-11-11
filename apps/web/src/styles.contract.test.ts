import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS } from "./lib/design-tokens.ts";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

function media(condition: string): string {
  const opener = `@media ${condition} {`;
  const blocks: string[] = [];
  let start = css.indexOf(opener);
  while (start !== -1) {
    const body = start + opener.length;
    let depth = 1;
    let end = body;
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
    }
    expect(depth, `unclosed media ${condition}`).toBe(0);
    blocks.push(css.slice(body, end - 1));
    start = css.indexOf(opener, end);
  }
  expect(blocks.length, `missing media ${condition}`).toBeGreaterThan(0);
  return blocks.join("\n");
}

it("disables mobile text autosizing so long rows keep the base size", () => {
  const html = rule("html");
  expect(html).toContain("-webkit-text-size-adjust: 100%");
  expect(html).toContain("text-size-adjust: 100%");
});

it("hides a failed chart canvas while retaining its mount target", () => {
  expect(rule(".chart-canvas[hidden]")).toContain("display: none");
});

it("renders reasoning Markdown without inheriting literal pre-wrap whitespace", () => {
  expect(rule(".reasoning-body > .chat-markdown")).toContain("white-space: normal");
});

it("colors only the owning child header by state, leaving completion neutral", () => {
  for (const [state, hue] of [
    ["running", "--ok"],
    ["failed", "--bad"],
  ]) {
    const selector = `.tool-activity-call.tool-call-${state} > summary,\n.tool-activity-call.tool-call-${state} > summary > .tool-call-marker,\n.tool-activity-call.tool-call-${state} > summary > .tool-call-status`;
    expect(rule(selector)).toContain(`color: var(${hue})`);
  }
  expect(css).toContain(
    ".tool-activity-call:not(details),\n.tool-activity-call > summary {\n  color: var(--k);",
  );
  expect(rule(".tool-call-marker")).toContain("color: var(--k)");
  expect(rule(".activity-rail-headline,\n.activity-rail-metric,\n.tool-call-status")).toContain(
    "color: var(--g3)",
  );
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
    expect(band).toContain("padding: 8px 12px");
    expect(band).toContain("background: var(--alert)");
    expect(band).toContain("color: var(--on-alert)");
    expect(band).toContain("white-space: pre-wrap");
    expect(band).toContain("overflow-wrap: anywhere");
    expect(rule(".orb-entry-alert")).not.toContain("background");
    expect(rule(".rec-bd")).toContain("min-width: 0");
  });
});

it("gives Links and Files the same enclosure and summary geometry as Subagents", () => {
  const enclosure = rule(
    ".subagent-live-rail.activity-rail-row,\n.orb-links.activity-rail-row,\n.hosted-files.activity-rail-row",
  );
  expect(enclosure).toContain("margin: 0");
  expect(enclosure).toContain("border-bottom: 1px solid var(--g2)");
  const summary = rule(
    ".subagent-live-rail > summary,\n.orb-links > summary,\n.hosted-files > summary",
  );
  expect(summary).toContain("min-height: 20px");
  expect(summary).toContain("padding: 0 12px");
  expect(rule(".hosted-files-inventory")).toContain("border-top: 1px solid var(--g2)");
});

describe("subagent roster", () => {
  it("has no nested disclosure-marker or identity-only styles", () => {
    expect(css).not.toMatch(/\.subagent-roster[^{}]*::before/);
    expect(css).not.toContain(".subagent-roster .subagent-identity");
    expect(rule(".subagent-roster > li")).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });
});

describe("composer typography", () => {
  it("leaves the native composer caret visible without an overlay", () => {
    expect(rule("input:focus,\ntextarea:focus")).toContain("caret-color: var(--k)");
    expect(css).not.toContain(".composer-caret");
    expect(css).not.toContain("data-block-caret");
    expect(css).not.toContain("caret-color: transparent");
  });

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
      /@media \(max-width: 600px\), \(any-pointer: coarse\)\s*\{\s*input,\s*textarea,\s*select\s*\{\s*font-size: 16px;/,
    );
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain("width=device-width, initial-scale=1");
    expect(html).not.toMatch(/user-scalable|maximum-scale|minimum-scale/);
  });
});

describe("bundled typography", () => {
  it("matches served font bytes, cache keys and study copies to the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../public/fonts/manifest.json", import.meta.url), "utf8"),
    ) as {
      assets: { file: string; sha256: string; family: string; weight: number; style: string }[];
    };
    const study = readFileSync(
      new URL("../../../design-prototypes/programming-fonts.html", import.meta.url),
      "utf8",
    );
    const studyFaces = [...study.matchAll(/@font-face\{([^}]+)\}/g)];
    for (const asset of manifest.assets) {
      const bytes = readFileSync(new URL(`../public/fonts/${asset.file}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), asset.file).toBe(asset.sha256);
      expect(asset.file).toContain(asset.sha256.slice(0, 12));
      expect(css).toContain(`url("/fonts/${asset.file}")`);
      if (asset.family !== "Iosevka Etoile") continue;
      const face = studyFaces.find(
        ([, declarations]) =>
          declarations?.includes('font-family:"StudyFont5"') &&
          declarations.includes(`font-weight:${asset.weight};`) &&
          declarations.includes(`font-style:${asset.style};`),
      )?.[1];
      const embedded = /base64,([^"]+)/.exec(face ?? "")?.[1];
      expect(embedded, asset.file).toBeDefined();
      expect(
        createHash("sha256")
          .update(Buffer.from(embedded ?? "", "base64"))
          .digest("hex"),
        `study copy of ${asset.file}`,
      ).toBe(asset.sha256);
    }
  });

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
    const phone = media("(max-width: 600px)");
    expect(rule(".orb-rename-form", phone)).toContain("flex-wrap: wrap");
    expect(rule(".orb-rename-form > .text-field-frame", phone)).toContain("width: 80px");
  });

  it("uses a neutral highlight on every paper surface", () => {
    expect(rule("::selection")).toContain("background: var(--g2)");
    expect(rule("::selection")).toContain("color: var(--k)");
  });
});

it("sets the CI waterfall on 20px rows with the 2px ring of a plot", () => {
  expect(rule(".link-timeline")).toContain("line-height: 20px");
  expect(rule(".link-timeline-dot > .activity-strip-dot")).toContain("height: 20px");
  expect(rule(".link-timeline-bar")).toContain("top: 5px");
  expect(rule(".link-timeline-unfolds:focus-visible")).toContain("outline: 2px solid var(--k)");
});

it.each([
  ["dashboard", ".orb-entry"],
  ["OrbIndex", ".ix-row"],
])("keeps %s orb names regular, including busy and failed", (_view, prefix) => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
    selector?.includes(prefix),
  );
  expect(rules.length).toBeGreaterThan(0);
  for (const [, selector, declarations] of rules) {
    expect(declarations, selector).not.toMatch(/font(?:-weight)?\s*:/);
  }
});

describe("dashboard layout contract", () => {
  it("uses icon-only creation without a bottom text action", () => {
    expect(css).not.toContain(".project-new-orb-row");
    expect(rule(".project-name")).toContain("min-width: 0");
    expect(rule(".project-head-actions > .icon-button", media("(max-width: 600px)"))).toContain(
      "width: 44px",
    );
  });
  it("positions project boxes absolutely for masonry placement", () => {
    expect(rule(".dashboard")).toContain("position: relative");
    expect(rule(".dashboard")).toContain("flex: 1 0 auto");
    expect(rule(".dashboard")).toContain("background-repeat: no-repeat");
    expect(rule(".dashboard")).toContain("background-size: 1px 100%");
    expect(rule(".dashboard > *")).toContain("position: absolute");
    expect(rule(".dashboard-probe")).toContain("height: 0");
    expect(rule(".project-column")).toContain("border-left: 1px solid var(--k)");
    expect(rule(".project-column")).toContain("border-bottom: 1px solid var(--k)");
    expect(rule(".new-project")).toContain("border-left: 1px dashed var(--k)");
    // Covers the column rule painted beneath the dashed border.
    expect(rule(".new-project")).toContain("background: var(--w)");
  });

  it("rules the board from the totals strip to the bottom-pinned footer", () => {
    // Subtracts the totals strip and footer so one-orb columns still draw full-height rules.
    expect(rule(".dashboard")).toContain("min-height: calc(100dvh - 48px)");
    expect(rule(".dashboard-totals")).toContain("height: 24px");
    expect(rule(".dashboard-totals")).toContain("border-bottom: 1px solid var(--k)");
    expect(rule(".dashboard-total")).toContain("border-right: 1px solid var(--k)");
    expect(rule(".dashboard-footer")).toContain("position: sticky");
    expect(rule(".dashboard-footer")).toContain("bottom: 0");
    expect(rule(".dashboard-footer")).toContain("height: 24px");
    expect(rule(".dashboard-footer")).toContain("border-top: 1px solid var(--k)");
  });

  it("gives the project name 18px and the orb name the base size on their own lines", () => {
    expect(rule(".project-head-name")).toContain("height: 24px");
    expect(rule(".project-name")).toContain("font-size: 18px");
    expect(rule(".project-name")).toContain("line-height: 24px");
    expect(rule(".new-project h2")).toContain("font-size: 18px");
    expect(rule(".orb-entry-link")).not.toContain("font-size");
  });

  it("keeps every dashboard orb entry on its line grid behind its state hue", () => {
    expect(rule(".orb-entry")).toContain("border-left: 2px solid var(--g2)");
    expect(rule(".orb-entry-deleting")).toContain("border-left-style: dotted");
    expect(rule(".orb-entry-title")).toContain("height: var(--row)");
    expect(rule(".orb-entry-title")).toContain("align-items: center");
    expect(rule(".orb-entry-link")).toContain("white-space: nowrap");
    expect(rule(".orb-entry-meta")).toContain("height: var(--row)");
    expect(rule(".orb-entry-error")).toContain("color: var(--bad)");
  });

  it("uses the stopped gray hue for sleeping rows without overriding selected fill", () => {
    expect(rule(".s-sleeping")).toContain("color: var(--st-sleeping)");
    expect(rule(".orb-entry-sleeping")).toContain("border-left-color: var(--st-sleeping)");
    expect(
      rule(
        ".orb-entry-stopped .orb-entry-link,\n.orb-entry-sleeping .orb-entry-link,\n.orb-entry-archived .orb-entry-link,\n.orb-entry-archiving .orb-entry-link,\n.orb-entry-deleting .orb-entry-link",
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
    expect(user).toContain("background: var(--you)");
    expect(user).toContain("color: var(--on-you)");
    expect(user).toContain("font-weight: 400");
    expect(rule(".rec-you .chat-markdown :not(pre) > code")).toContain("color: var(--k)");
    expect(rule(".rec-you .markdown-code-block")).toContain("background: var(--w)");
    const error = rule(".rec-you .error-text");
    expect(error).toContain("color: var(--bad)");
    expect(error).toContain("background: var(--w)");
  });

  it("keeps notification bodies literal and wrapping, with linked senders", () => {
    expect(rule(".peer-notice > summary")).toContain("minmax(0, 40%)");
    expect(rule(".peer-sender")).toContain("text-overflow: ellipsis");
    expect(rule(".peer-notice .rec-status")).toContain("flex: none");
    expect(rule(".peer-sender")).toContain("border-bottom: 1px solid currentcolor");
    expect(rule(".peer-body")).toContain("white-space: pre-wrap");
    expect(rule(".peer-body")).toContain("overflow-wrap: anywhere");
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
    expect(rule(".app:has(.orb-page)")).toContain("position: fixed");
    expect(rule(".app:has(.orb-page)")).toContain("top: var(--visual-viewport-top, 0px)");
    expect(rule(".app:has(.orb-page)")).toContain("height: var(--visual-viewport-height, 100dvh)");
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
    expect(rule(".orb-index")).toContain("top: var(--visual-viewport-top, 0px)");
    expect(rule(".orb-index")).toContain("height: var(--visual-viewport-height, 100dvh)");
    expect(rule(".orb-index")).toContain("width: 236px");
    expect(rule(".orb-index")).toContain("overflow-y: auto");
    expect(rule(".orb-main")).toContain("grid-column: 2");
    expect(rule(".app:has(> .session-ribbon) .orb-index")).toContain(
      "top: calc(var(--visual-viewport-top, 0px) + var(--bar))",
    );
    expect(rule(".app:has(> .session-ribbon) .orb-index")).toContain(
      "height: calc(var(--visual-viewport-height, 100dvh) - var(--bar))",
    );
    const phone = media("(max-width: 600px)");
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
    expect(rule(".rec-q")).toContain("border-left: 2px dotted var(--on-you)");
    expect(rule(".tag")).toContain("border: 1px solid currentcolor");
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
    expect(terminal).toContain("padding: 12px 0");
    expect(rule(".orb-terminal-window .orb-terminal-emulator")).toContain("padding: 0 12px");
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
    expect(rule("button.icon-button,\na.icon-button")).toContain("width: 20px");
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
    expect(dialog).toContain("max-height: calc(100dvh - 32px)");
    expect(full).toContain("max-height: calc(100dvh - 74px)");
    expect(css).toMatch(
      /@media \(max-width: 600px\), \(any-pointer: coarse\) \{\s*\.tool-image-dialog \{[^}]*\}\s*button\.tool-image-dialog-close \{[^}]*width: 44px;[^}]*height: 44px/,
    );
  });
});

it("gives owner skill disclosures and the add action phone touch targets", () => {
  const phone = media("(max-width: 600px)");
  const dialog = ".personal-instructions-dialog";
  expect(rule(`${dialog} .project-mcp-connection > summary`, phone)).toContain("min-height: 44px");
  expect(rule(`${dialog} .mcp-add-area > .text-action::before`, phone)).toContain("inset: -16px");
});

it("reserves native keyboard chrome only for the focused phone editor", () => {
  expect(rule(".composer:has(.composer-input:focus)", media("(max-width: 600px)"))).toContain(
    "padding-bottom: max(env(safe-area-inset-bottom), var(--keyboard-accessory-inset, 0px))",
  );
});

describe("Signal / Boards system", () => {
  const rootBlock = /:root \{[^}]*\}/.exec(css)?.[0] ?? "";
  const darkBlock =
    /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*\}\s*\}/.exec(css)?.[0] ?? "";
  const body = css
    .replace(rootBlock, "")
    .replace(darkBlock, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const value = (block: string, name: string) =>
    new RegExp(`${name}: ([^;]+);`).exec(block)?.[1]?.trim();
  const declared = (name: string) => value(rootBlock, name);

  it("keeps color literals in :root", () => {
    expect(body.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
  });

  it("uses only custom properties that the CSS declares or the app sets", () => {
    const sources = readdirSync(new URL(".", import.meta.url), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
    const undeclared = [...used].filter(
      (name) => !css.includes(`${name}:`) && !new RegExp(`["'\`]${name}["':]`).test(sources),
    );
    expect(undeclared).toEqual([]);
  });

  it("stays on the spacing scale", () => {
    const scale = new Set(["0", "1", "2", "4", "6", "8", "12", "16", "20", "24"]);
    const offScale = [
      ...body.matchAll(/(?:^|[\s;{])(?:gap|padding[a-z-]*|margin[a-z-]*): ([^;]+);/g),
    ]
      .flatMap((match) => [...(match[1] ?? "").matchAll(/(?<![\w.])-?(\d+)px/g)])
      .map((value) => value[1] ?? "")
      .filter((value) => Number(value) <= 24 && !scale.has(value));
    expect(offScale).toEqual([]);
  });

  it("stays on the type, breakpoint and touch scales", () => {
    const sizes = new Set([...css.matchAll(/font-size: (\d+)px/g)].map((match) => match[1]));
    expect([...sizes].sort()).toEqual(["11", "16", "18", "26"].sort());
    const widths = new Set([...css.matchAll(/width: (\d+)px\)/g)].map((match) => match[1]));
    expect([...widths].sort()).toEqual(["600", "601", "900"].sort());
    expect(css).not.toMatch(/(?:width|height): 48px/);
  });

  it("names orb states as the favicons do", () => {
    for (const state of [
      "running",
      "transitional",
      "stopped",
      "sleeping",
      "failed",
      "archived",
      "archiving",
      "deleting",
    ]) {
      expect(rule(`.s-${state}`)).toContain(`color: var(--st-${state})`);
      expect(css).toContain(`.orb-entry-${state} {`);
    }
    expect(css).not.toMatch(/\.(?:s|orb-entry)-(?:idle|start|stop|sleep|fail|arch|archng|del)\b/);
  });

  it("uses one inactive gray, one red and no signal hue on ink", () => {
    expect(declared("--st-stopped")).toBe("var(--g3)");
    expect(declared("--st-sleeping")).toBe("var(--g3)");
    expect(declared("--st-archived")).toBe("var(--g3)");
    expect(declared("--st-transitional")).toBe("var(--warn)");
    expect(declared("--ok-bg")).toBeUndefined();
    expect(rule(".alert-band")).toContain("background: var(--alert)");
    expect(rule(".activity-strip-tip")).toContain("background: var(--w)");
    expect(rule(".activity-strip-tip")).toContain("border: 1px solid var(--k)");
  });

  it("makes one banner, one tag and one section heading", () => {
    expect(css).not.toMatch(/\.notice\b/);
    expect(rule(".tag")).toContain("border: 1px solid currentcolor");
    expect(css).not.toContain(".usage-page :is(h2, h3)");
    expect(rule(".session-ribbon")).toContain("border-bottom: 1px solid var(--bad)");
    expect(rule(".orb-entry-alert")).toBe("\n  border-left-color: var(--bad);\n");
  });

  it("gives phone orb actions 44px tap areas without growing the row", () => {
    const touch = media("(max-width: 600px), (any-pointer: coarse)");
    expect(rule(".orb-entry-actions", touch)).toContain("gap: 0");
    expect(rule(".orb-entry-actions .icon-button", touch)).toContain("width: 44px");
    expect(rule(".orb-entry-actions .icon-button::before", touch)).toContain("inset: -12px 0");
    expect(rule(".orb-entry-meta")).toContain("height: var(--row)");
  });

  it("flips the primary button to paper on focus and never bolds selection", () => {
    expect(rule(":is(button, a, summary):focus-visible")).toContain(
      "background: var(--k) !important",
    );
    expect(rule(".new-project button:focus-visible")).toContain("background: var(--w) !important");
    expect(rule(".ix-row-current,\n.ix-row-current:hover")).not.toContain("font-weight");
    expect(css).not.toContain(".subagent-message-notice > summary:focus-visible");
  });

  it("publishes renderer colors that match both themes", () => {
    for (const name of ["w", "k", "g1", "g1x", "g2", "g3", "bad"] as const) {
      expect(TOKENS.light[name]).toBe(declared(`--${name}`));
      expect(TOKENS.dark[name]).toBe(value(darkBlock, `--${name}`));
    }
  });

  describe("dark theme", () => {
    const hex = (name: string) => value(darkBlock, name) ?? "";
    const luminance = (color: string) => {
      const digits = color.slice(1);
      const full = digits.length === 3 ? digits.replace(/./g, "$&$&") : digits;
      const [r = 0, g = 0, b = 0] = [0, 2, 4]
        .map((at) => Number.parseInt(full.slice(at, at + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };

    it("follows the desktop setting", () => {
      expect(rootBlock).toContain("color-scheme: light dark");
      expect(darkBlock).not.toBe("");
    });

    it("keeps text AA on every surface", () => {
      for (const surface of ["--w", "--g1", "--g1x", "--you"]) {
        for (const text of ["--k", "--g3"]) {
          expect(contrast(hex(text), hex(surface)), `${text} on ${surface}`).toBeGreaterThan(4.5);
        }
      }
      for (const surface of ["--w", "--g1", "--g1x"]) {
        for (const text of ["--ok", "--warn", "--bad"]) {
          expect(contrast(hex(text), hex(surface)), `${text} on ${surface}`).toBeGreaterThan(4.5);
        }
      }
      expect(contrast(hex("--bad"), hex("--bad-bg"))).toBeGreaterThan(4.5);
      for (const fill of ["--g3", "--ok", "--warn", "--bad"]) {
        expect(contrast(hex("--w"), hex(fill)), `paper on ${fill}`).toBeGreaterThan(4.5);
      }
      for (const chart of [1, 2, 3, 4, 5, 6]) {
        expect(contrast(hex(`--chart-${chart}`), hex("--w"))).toBeGreaterThan(3);
      }
    });

    it("overrides only the surfaces that are not a plain flip", () => {
      expect(hex("--you")).toBe("#2b2b2b");
      expect(hex("--alert")).toBe(declared("--bad"));
      expect(value(darkBlock, "--tile-gray")).toBeUndefined();
      expect(value(darkBlock, "--image-backing")).toBeUndefined();
      expect(declared("--tile-gray")).toBe("#555");
      expect(declared("--image-backing")).toBe("#fff");
      expect(rule(".rec-you")).toContain("background: var(--you)");
      expect(rule(".alert-band")).toContain("background: var(--alert)");
      expect(rule(".msg-image")).toContain("background: var(--image-backing)");
      expect(rule(".tool-image-thumbnail")).toContain("background: var(--image-backing)");
      expect(rule(".tool-image-full")).toContain("background: var(--image-backing)");
      expect(rule(".composer-attachment img")).toContain("background: var(--image-backing)");
    });
  });

  it("colors favicon tiles from the same tokens", () => {
    const allowed = new Set(["#555555", "#1a7e37", "#966100", "#b42318"]);
    const dir = new URL("../public/favicons/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".svg"))) {
      const svg = readFileSync(new URL(file, dir), "utf8");
      for (const match of svg.matchAll(/fill="(#[0-9a-f]+)"/g)) {
        expect(allowed.has(match[1] ?? ""), `${file}: ${match[1]}`).toBe(true);
      }
    }
  });
});
