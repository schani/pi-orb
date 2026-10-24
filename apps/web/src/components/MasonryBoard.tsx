import { type ReactNode, useRef } from "react";
import { useMasonry } from "../lib/use-masonry.ts";

/** The dashboard board: each child stays one box, dropped into the shortest column. */
export function MasonryBoard({
  minColumnWidth,
  children,
}: {
  minColumnWidth: number;
  children: ReactNode;
}) {
  const board = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  useMasonry(board, probe, minColumnWidth);
  return (
    <>
      <div className="dashboard-probe" ref={probe} />
      <div className="dashboard" ref={board}>
        {children}
      </div>
    </>
  );
}
