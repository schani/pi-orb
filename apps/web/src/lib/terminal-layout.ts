export interface SnapTerminalSizeInput {
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly horizontalChrome: number;
  readonly verticalChrome: number;
}

export interface TerminalGridSize {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalGridMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly horizontalChrome: number;
  readonly verticalChrome: number;
}

const MIN_WIDTH = 330;
const MIN_HEIGHT = 220;

function snapAxis(raw: number, max: number, chrome: number, cell: number, minimum: number) {
  const minCells = Math.ceil((minimum - chrome) / cell);
  const maxCells = Math.max(minCells, Math.floor((max - chrome) / cell));
  const cells = Math.max(minCells, Math.min(maxCells, Math.round((raw - chrome) / cell)));
  return { pixels: chrome + cells * cell, cells };
}

/** Derives an outer panel whose content viewport contains exactly the requested grid. */
export function terminalPanelSize(
  grid: Pick<TerminalGridSize, "cols" | "rows">,
  metrics: TerminalGridMetrics,
): Pick<TerminalGridSize, "width" | "height"> {
  return {
    width: metrics.horizontalChrome + grid.cols * metrics.cellWidth,
    height: metrics.verticalChrome + grid.rows * metrics.cellHeight,
  };
}

/** Keeps the fixed bottom-right anchor stable while the top-left handle moves by whole cells. */
export function snapTerminalSize(input: SnapTerminalSizeInput): TerminalGridSize {
  const width = snapAxis(
    input.rawWidth,
    input.maxWidth,
    input.horizontalChrome,
    input.cellWidth,
    MIN_WIDTH,
  );
  const height = snapAxis(
    input.rawHeight,
    input.maxHeight,
    input.verticalChrome,
    input.cellHeight,
    MIN_HEIGHT,
  );
  return { width: width.pixels, height: height.pixels, cols: width.cells, rows: height.cells };
}
