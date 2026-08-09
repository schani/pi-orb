import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_SUBPROTOCOL,
  TerminalClientControlSchema,
  TerminalServerControlSchema,
} from "./terminal.ts";

describe("terminal protocol", () => {
  it("accepts bounded open and resize controls", () => {
    expect(TERMINAL_SUBPROTOCOL).toBe("pi-orb.terminal.v1");
    expect(
      Check(TerminalClientControlSchema, { v: 1, type: "terminal.open", cols: 80, rows: 24 }),
    ).toBe(true);
    expect(
      Check(TerminalClientControlSchema, { v: 1, type: "terminal.resize", cols: 132, rows: 41 }),
    ).toBe(true);
    expect(
      Check(TerminalClientControlSchema, { v: 1, type: "terminal.resize", cols: 0, rows: 24 }),
    ).toBe(false);
    expect(
      Check(TerminalClientControlSchema, {
        v: 1,
        type: "terminal.resize",
        cols: 80,
        rows: 24,
        extra: true,
      }),
    ).toBe(false);
  });

  it("defines ready, exit, and typed error controls", () => {
    expect(
      Check(TerminalServerControlSchema, { v: 1, type: "terminal.ready", cols: 80, rows: 24 }),
    ).toBe(true);
    expect(
      Check(TerminalServerControlSchema, { v: 1, type: "terminal.exit", exitCode: 7, signal: 0 }),
    ).toBe(true);
    expect(
      Check(TerminalServerControlSchema, {
        v: 1,
        type: "terminal.error",
        error: { code: "limit_reached", message: "too many terminals", retryable: true },
      }),
    ).toBe(true);
  });
});
