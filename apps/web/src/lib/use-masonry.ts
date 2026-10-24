import { type RefObject, useLayoutEffect, useRef } from "react";
import { devConsoleDebug } from "./dev-console-debug.ts";
import { masonryColumns, placeMasonry } from "./masonry.ts";

/**
 * Positions the board's children absolutely in shortest-column order. Children stay where React
 * put them in the DOM, so moving a box between columns never remounts it. `probe` is a
 * zero-height sibling spanning the board's width: observing it instead of the board keeps the
 * board's own height writes from re-entering the observer. Layout also runs in the commit of
 * every board render, so an inserted box is placed before any observer can see it unplaced.
 */
export function useMasonry(
  board: RefObject<HTMLElement | null>,
  probe: RefObject<HTMLElement | null>,
  minColumnWidth: number,
): void {
  const relayout = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const boardElement = board.current;
    const probeElement = probe.current;
    if (boardElement === null || probeElement === null) return;
    let traced = "";
    const layout = () => {
      const items = [...boardElement.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
      const columns = masonryColumns(probeElement.getBoundingClientRect().width, minColumnWidth);
      for (const item of items) item.style.width = `${columns.width}px`;
      const placed = placeMasonry(
        items.map((item) => item.getBoundingClientRect().height),
        columns.count,
      );
      items.forEach((item, index) => {
        const placement = placed.items[index];
        if (placement === undefined) return;
        item.style.left = `${placement.column * columns.width}px`;
        item.style.top = `${placement.top}px`;
      });
      boardElement.style.height = `${placed.height}px`;
      boardElement.style.backgroundImage = Array.from(
        { length: columns.count },
        () => "linear-gradient(var(--k), var(--k))",
      ).join(", ");
      boardElement.style.backgroundPosition = Array.from(
        { length: columns.count },
        (_, column) => `${column * columns.width}px 0`,
      ).join(", ");
      const shape = `${columns.count}:${items.length}`;
      if (shape !== traced) {
        traced = shape;
        devConsoleDebug.record({
          event: "masonry",
          outcome: `columns=${columns.count}`,
          recordCount: items.length,
          contentHeight: placed.height,
        });
      }
    };
    const observed = new WeakSet<Element>();
    const resize = new ResizeObserver(layout);
    const observeItems = () => {
      for (const child of boardElement.children) {
        if (observed.has(child)) continue;
        observed.add(child);
        resize.observe(child);
      }
    };
    relayout.current = () => {
      observeItems();
      layout();
    };
    resize.observe(probeElement);
    return () => {
      relayout.current = () => {};
      resize.disconnect();
    };
  }, [board, probe, minColumnWidth]);
  useLayoutEffect(() => relayout.current());
}
