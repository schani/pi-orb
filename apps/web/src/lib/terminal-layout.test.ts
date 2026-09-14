import { describe, expect, it } from "vitest";
import { terminalShadeLayout } from "./terminal-layout.ts";

const metrics = {
  cellWidth: 8,
  cellHeight: 20,
  horizontalChrome: 32,
  verticalChrome: 28,
};

describe("terminal shade layout", () => {
  it("fits whole terminal rows beneath the header without snapping the panel width", () => {
    expect(terminalShadeLayout({ width: 1000, availableHeight: 600 }, metrics)).toEqual({
      cols: 121,
      rows: 12,
      height: 268,
      contentHeight: 268,
      maxRows: 28,
    });
  });

  it("leaves at least a fifth of the available conversation visible", () => {
    expect(terminalShadeLayout({ width: 390, availableHeight: 250 }, metrics)).toEqual({
      cols: 44,
      rows: 8,
      height: 188,
      contentHeight: 188,
      maxRows: 11,
    });
  });

  it("clips the minimum grid to whole visible rows inside a very short shade", () => {
    expect(terminalShadeLayout({ width: 200, availableHeight: 100 }, metrics)).toEqual({
      cols: 21,
      rows: 5,
      height: 68,
      contentHeight: 128,
      maxRows: 5,
    });
  });

  it("resizes by exact rows beyond the initial height, clamped above the composer", () => {
    const bounds = { width: 1000, availableHeight: 600 };
    const initial = terminalShadeLayout(bounds, metrics);
    const expanded = terminalShadeLayout(bounds, metrics, initial.rows + 3);
    expect(expanded.height - initial.height).toBe(60);
    expect(terminalShadeLayout(bounds, metrics, 999).rows).toBe(28);
    expect(terminalShadeLayout(bounds, metrics, -10).rows).toBe(5);
    expect(terminalShadeLayout(bounds, metrics, 15.4).rows).toBe(15);
    expect(terminalShadeLayout(bounds, metrics, 15.6).rows).toBe(16);
    expect(terminalShadeLayout({ ...bounds, availableHeight: 200 }, metrics, 28).height).toBe(188);
  });

  it("respects the protocol bounds without spilling into the composer", () => {
    for (const width of [0, 180, 390, 10000]) {
      for (const availableHeight of [0, 80, 250, 900]) {
        const layout = terminalShadeLayout({ width, availableHeight }, metrics);
        expect(layout.cols).toBeGreaterThanOrEqual(20);
        expect(layout.cols).toBeLessThanOrEqual(500);
        expect(layout.rows).toBeGreaterThanOrEqual(5);
        expect(layout.height).toBeLessThanOrEqual(availableHeight);
        expect((layout.contentHeight - metrics.verticalChrome) % metrics.cellHeight).toBe(0);
        if (layout.height >= metrics.verticalChrome) {
          expect((layout.height - metrics.verticalChrome) % metrics.cellHeight).toBe(0);
        }
      }
    }
  });
});
