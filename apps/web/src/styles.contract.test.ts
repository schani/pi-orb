import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("orb workspace layout contract", () => {
  it("carries viewport height through the app to the bottom-pinned composer", () => {
    expect(rule(".app")).toContain("display: flex");
    expect(rule(".app")).toContain("min-height: 100dvh");
    expect(rule(".app")).toContain("flex-direction: column");
    expect(rule(".orb-page")).toContain("flex: 1");
    expect(rule(".orb-page > .history")).toContain("flex: 1 0 auto");
    expect(rule(".composer")).toContain("position: sticky");
    expect(rule(".composer")).toContain("z-index: 30");
    expect(rule(".composer")).toContain("bottom: 0");
  });

  it("stacks the approved terminal header above the emulator", () => {
    expect(rule(".orb-terminal-window")).toContain("display: flex");
    expect(rule(".orb-terminal-window")).toContain("flex-direction: column");
    expect(rule(".orb-terminal-header")).toContain("flex: 0 0 38px");
  });

  it("uses one rail-row geometry for reasoning and every tool category", () => {
    expect(rule(".activity-rail-row > summary")).toContain(
      "grid-template-columns: var(--gutter) 14px minmax(0, 1fr)",
    );
    expect(rule(".activity-rail-marker")).toContain("grid-column: 1");
    expect(rule(".activity-rail-marker")).toContain("justify-self: center");
    expect(rule(".activity-rail-row-completed .activity-rail-marker")).toContain(
      "background: var(--green)",
    );
    expect(rule(".activity-rail-row-failed .activity-rail-marker")).toContain(
      "background: var(--accent)",
    );
    expect(rule(".activity-rail-row-failed .activity-rail-label")).toContain(
      "color: var(--accent)",
    );
    expect(rule(".activity-rail-row-completed .activity-rail-label")).toContain(
      "color: var(--green)",
    );
    expect(rule(".activity-rail-row > summary")).toContain("min-height: 34px");
    expect(rule(".activity-rail-summary")).toContain("min-height: 34px");
    expect(rule(".activity-rail-summary")).toContain("align-items: center");
    expect(rule(".activity-rail-summary")).toContain(
      "grid-template-columns: clamp(96px, 10vw, 150px) minmax(0, 1fr) auto",
    );
    expect(rule(".activity-rail-headline")).toContain("overflow: hidden");
    expect(rule(".activity-rail-headline")).toContain("text-overflow: ellipsis");
    expect(rule(".activity-rail-headline")).toContain("white-space: nowrap");
    expect(rule(".activity-rail-row[open] > summary .activity-rail-summary")).toContain(
      "border-bottom-color: transparent",
    );
    expect(rule(".activity-rail-label")).toContain("font-weight: 400");
  });
});
