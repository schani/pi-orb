import { describe, expect, it } from "vitest";
import { masonryColumns, placeMasonry } from "./masonry.ts";

describe("masonryColumns", () => {
  it("fits as many whole-pixel columns of at least the minimum width as the board allows", () => {
    expect(masonryColumns(1280, 316)).toEqual({ count: 4, width: 320 });
    expect(masonryColumns(1667, 316)).toEqual({ count: 5, width: 333 });
    expect(masonryColumns(632, 316)).toEqual({ count: 2, width: 316 });
  });

  it("gives a narrow board one full-width column", () => {
    expect(masonryColumns(631, 316)).toEqual({ count: 1, width: 631 });
    expect(masonryColumns(320, 316)).toEqual({ count: 1, width: 320 });
    expect(masonryColumns(0, 316)).toEqual({ count: 1, width: 0 });
  });
});

describe("placeMasonry", () => {
  it("drops each box, in order, into the currently shortest column", () => {
    expect(placeMasonry([800, 100, 120, 50, 200, 40, 40, 150], 5)).toEqual({
      items: [
        { column: 0, top: 0 },
        { column: 1, top: 0 },
        { column: 2, top: 0 },
        { column: 3, top: 0 },
        { column: 4, top: 0 },
        { column: 3, top: 50 },
        { column: 3, top: 90 },
        { column: 1, top: 100 },
      ],
      height: 800,
    });
  });

  it("breaks ties toward the leftmost column", () => {
    expect(placeMasonry([10, 10, 10], 2).items.map((item) => item.column)).toEqual([0, 1, 0]);
  });

  it("stacks every box in one column when only one fits", () => {
    expect(placeMasonry([30, 20, 10], 1)).toEqual({
      items: [
        { column: 0, top: 0 },
        { column: 0, top: 30 },
        { column: 0, top: 50 },
      ],
      height: 60,
    });
  });

  it("has no height without boxes", () => {
    expect(placeMasonry([], 3)).toEqual({ items: [], height: 0 });
  });
});
