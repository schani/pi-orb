import { describe, expect, it } from "vitest";
import { normalizeTerminalSelection } from "./terminal-copy.ts";

describe("normalizeTerminalSelection", () => {
  it("removes terminal padding at each selected row edge", () => {
    expect(
      normalizeTerminalSelection(
        "frontend fixture terminal                                              \norb@frontend:~/repo$ ",
      ),
    ).toBe("frontend fixture terminal\norb@frontend:~/repo$");
  });

  it("preserves line breaks and non-padding whitespace", () => {
    expect(normalizeTerminalSelection("  one two  \n   \nthree\tfour\u00a0  \n")).toBe(
      "  one two\n\nthree\tfour\u00a0\n",
    );
  });
});
