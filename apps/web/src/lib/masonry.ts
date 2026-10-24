export interface MasonryColumns {
  count: number;
  width: number;
}

export interface MasonryPlacement {
  column: number;
  top: number;
}

/** Equal whole-pixel columns so box borders and the board's column rules share pixels. */
export function masonryColumns(boardWidth: number, minColumnWidth: number): MasonryColumns {
  const count = Math.max(1, Math.floor(boardWidth / minColumnWidth));
  return { count, width: Math.floor(boardWidth / count) };
}

/** Pinterest placement: each box, in order, goes to the shortest column (leftmost on ties). */
export function placeMasonry(
  heights: readonly number[],
  columnCount: number,
): { items: MasonryPlacement[]; height: number } {
  const bottoms = Array.from({ length: columnCount }, () => 0);
  const items = heights.map((height) => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const top = bottoms[column] ?? 0;
    bottoms[column] = top + height;
    return { column, top };
  });
  return { items, height: Math.max(0, ...bottoms) };
}
