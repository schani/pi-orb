import { expect, it } from "vitest";
import { stripTipStyle } from "./strip-tip.ts";

it("starts at a dot in the left half of the viewport", () => {
  expect(stripTipStyle({ left: 100, right: 112, top: 50 }, 1000)).toEqual({
    left: 84,
    top: 26,
    maxWidth: "min(60ch, calc(100vw - 92px))",
  });
  expect(stripTipStyle({ left: 10, right: 22, top: 50 }, 1000).left).toBe(4);
});

it("ends at a dot in the right half so it grows leftward instead of off-screen", () => {
  expect(stripTipStyle({ left: 950, right: 962, top: 50 }, 1000)).toEqual({
    right: 22,
    top: 26,
    maxWidth: "min(60ch, calc(100vw - 30px))",
  });
  expect(stripTipStyle({ left: 990, right: 1000, top: 50 }, 1000).right).toBe(4);
});
