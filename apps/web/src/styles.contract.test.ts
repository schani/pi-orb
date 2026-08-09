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
    expect(rule(".composer")).toContain("bottom: 0");
  });

  it("stacks the approved terminal header above the emulator", () => {
    expect(rule(".orb-terminal-window")).toContain("display: flex");
    expect(rule(".orb-terminal-window")).toContain("flex-direction: column");
    expect(rule(".orb-terminal-header")).toContain("flex: 0 0 38px");
  });
});
