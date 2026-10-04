import { describe, expect, it } from "vitest";
import { initialTailIndex, retainedTailIndex, upwardRevealIndex } from "./history-tail.ts";

describe("history tail boundary", () => {
  it("bounds initial rows but never evicts revealed rows on append", () => {
    expect(initialTailIndex(60)).toBe(40);
    expect(retainedTailIndex(["old", "first", "new", "appended"], "first")).toBe(1);
    expect(initialTailIndex(3)).toBe(0);
  });
  it("reveals fixed batches only after upward intent near the top", () => {
    expect(upwardRevealIndex(45, 0, false)).toBe(45);
    expect(upwardRevealIndex(45, 500, true)).toBe(45);
    expect(upwardRevealIndex(45, 0, true)).toBe(25);
    expect(upwardRevealIndex(25, 80, true)).toBe(5);
    expect(upwardRevealIndex(5, 0, true)).toBe(0);
    expect(upwardRevealIndex(0, 0, true)).toBe(0);
  });
  it("resets a replaced transcript boundary to its initial suffix", () => {
    expect(
      retainedTailIndex(
        Array.from({ length: 60 }, (_, i) => `new-${i}`),
        "gone",
      ),
    ).toBe(40);
  });
});
