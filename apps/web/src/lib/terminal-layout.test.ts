import { describe, expect, it } from "vitest";
import { snapTerminalSize, terminalPanelSize } from "./terminal-layout.ts";

describe("terminal layout", () => {
  it("derives a panel containing exactly the measured grid", () => {
    expect(
      terminalPanelSize(
        { cols: 65, rows: 17 },
        {
          cellWidth: 8,
          cellHeight: 19,
          horizontalChrome: 32,
          verticalChrome: 66,
        },
      ),
    ).toEqual({ width: 552, height: 389 });
  });

  it("snaps resize dimensions to complete character cells", () => {
    expect(
      snapTerminalSize({
        rawWidth: 559,
        rawHeight: 397,
        maxWidth: 900,
        maxHeight: 700,
        cellWidth: 8,
        cellHeight: 18,
        horizontalChrome: 24,
        verticalChrome: 40,
      }),
    ).toEqual({ width: 560, height: 400, cols: 67, rows: 20 });
  });

  it("clamps to minimum cells and available viewport", () => {
    expect(
      snapTerminalSize({
        rawWidth: 100,
        rawHeight: 100,
        maxWidth: 515,
        maxHeight: 307,
        cellWidth: 8,
        cellHeight: 18,
        horizontalChrome: 24,
        verticalChrome: 40,
      }),
    ).toEqual({ width: 336, height: 220, cols: 39, rows: 10 });
    expect(
      snapTerminalSize({
        rawWidth: 999,
        rawHeight: 999,
        maxWidth: 515,
        maxHeight: 307,
        cellWidth: 8,
        cellHeight: 18,
        horizontalChrome: 24,
        verticalChrome: 40,
      }),
    ).toEqual({ width: 512, height: 292, cols: 61, rows: 14 });
  });
});
