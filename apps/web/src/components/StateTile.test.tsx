import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveOrbFaviconStatus, FAVICON_HREFS } from "../lib/favicon.ts";
import { projectOrbGlyph } from "../lib/project-orbs.ts";
import { StateTile } from "./StateTile.tsx";

const states = [
  "running",
  "creating",
  "starting",
  "stopping",
  "stopped",
  "failed",
  "archived",
  "archiving",
  "deleting",
] as const;

describe("Instrument tiles", () => {
  for (const state of states) {
    for (const activity of ["idle", "busy"] as const) {
      it(`shares the ${state}/${activity} asset between favicon and UI`, () => {
        const glyph = projectOrbGlyph(state, activity);
        expect(glyph.iconHref).toBe(FAVICON_HREFS[deriveOrbFaviconStatus(state, "open", activity)]);
        const html = renderToStaticMarkup(<StateTile glyph={glyph} />);
        expect(html).toContain(`src="${glyph.iconHref}"`);
        expect(html).toContain(`alt="${glyph.label}"`);
        expect(html).toContain('width="16" height="16"');
      });
    }
  }

  it("keeps all nine states static, distinct, and font-independent on the same tile", () => {
    const assets = Object.values(FAVICON_HREFS).map((href) =>
      readFileSync(new URL(`../../public${href}`, import.meta.url), "utf8"),
    );
    expect(new Set(assets).size).toBe(9);
    const geometry = assets.map((svg) => svg.replace(/#[0-9a-f]{6}/g, "#777777"));
    expect(new Set(geometry).size).toBe(9);
    for (const svg of assets) {
      expect(svg).toContain('viewBox="0 0 16 16"');
      expect(svg).toContain('width="14" height="14" rx="2"');
      expect(svg).not.toMatch(/<text|<animate|<script/);
    }
    expect(assets[0]).toContain('d="M4 5h8M6 5v3.5Q6 10 5 11M10 5v5q0 1 1 1"');
  });

  it("uses the selected hourglass for transitions and bin for deletion", () => {
    const transition = readFileSync(
      new URL("../../public/favicons/transitional.svg", import.meta.url),
      "utf8",
    );
    const deleting = readFileSync(
      new URL("../../public/favicons/deleting.svg", import.meta.url),
      "utf8",
    );
    expect(transition).toContain('d="M5 4h6v1L5 11v1h6v-1L5 5z"');
    expect(deleting).toContain('d="M4 5h8M7 3h2M5 5v7h6V5M8 7v3"');
  });

  it("does not repeat the state for assistive technology beside a visible state word", () => {
    const html = renderToStaticMarkup(<StateTile glyph={projectOrbGlyph("failed")} decorative />);
    expect(html).toContain('alt=""');
    expect(html).toContain('title="failed"');
  });
});
