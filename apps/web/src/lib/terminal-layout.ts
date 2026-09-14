export interface TerminalGridMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly horizontalChrome: number;
  readonly verticalChrome: number;
}

/** Full-width shade; only its height snaps to cells, never the conversation width. */
export function terminalShadeLayout(
  bounds: { readonly width: number; readonly availableHeight: number },
  metrics: TerminalGridMetrics,
  preferredRows?: number,
) {
  const maximumHeight = Math.max(0, bounds.availableHeight);
  const maxRows = Math.max(
    5,
    Math.min(200, Math.floor((maximumHeight - metrics.verticalChrome) / metrics.cellHeight)),
  );
  const initialHeight = Math.min(280, maximumHeight * 0.8);
  const cols = Math.max(
    20,
    Math.min(500, Math.floor((bounds.width - metrics.horizontalChrome) / metrics.cellWidth)),
  );
  const rows = Math.max(
    5,
    Math.min(
      maxRows,
      preferredRows === undefined
        ? Math.floor((initialHeight - metrics.verticalChrome) / metrics.cellHeight)
        : Math.round(preferredRows),
    ),
  );
  const contentHeight = rows * metrics.cellHeight + metrics.verticalChrome;
  const allowedHeight = preferredRows === undefined ? initialHeight : maximumHeight;
  const visibleRows = Math.max(
    0,
    Math.min(rows, Math.floor((allowedHeight - metrics.verticalChrome) / metrics.cellHeight)),
  );
  return {
    cols,
    rows,
    maxRows,
    // Clip only whole rows when even the protocol's five-row minimum does
    // not fit. Neither padding nor a fractional row belongs in scrollback.
    height: Math.min(allowedHeight, visibleRows * metrics.cellHeight + metrics.verticalChrome),
    contentHeight,
  };
}
