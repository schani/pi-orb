import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;

export const TERMINAL_SUBPROTOCOL = "pi-orb.terminal.v1";
export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_ROWS = 200;
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024;

const dimensions = {
  cols: Type.Integer({ minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS }),
  rows: Type.Integer({ minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS }),
};

export const TerminalOpenSchema = Type.Object(
  { v: Type.Literal(1), type: Type.Literal("terminal.open"), ...dimensions },
  closed,
);
export type TerminalOpen = Static<typeof TerminalOpenSchema>;

export const TerminalResizeSchema = Type.Object(
  { v: Type.Literal(1), type: Type.Literal("terminal.resize"), ...dimensions },
  closed,
);
export type TerminalResize = Static<typeof TerminalResizeSchema>;

export const TerminalClientControlSchema = Type.Union([TerminalOpenSchema, TerminalResizeSchema]);
export type TerminalClientControl = Static<typeof TerminalClientControlSchema>;

export const TerminalReadySchema = Type.Object(
  { v: Type.Literal(1), type: Type.Literal("terminal.ready"), ...dimensions },
  closed,
);
export type TerminalReady = Static<typeof TerminalReadySchema>;

export const TerminalExitSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("terminal.exit"),
    exitCode: Type.Integer(),
    signal: Type.Integer(),
  },
  closed,
);
export type TerminalExit = Static<typeof TerminalExitSchema>;

export const TerminalErrorCodeSchema = Type.Union([
  Type.Literal("invalid_control"),
  Type.Literal("not_ready"),
  Type.Literal("limit_reached"),
  Type.Literal("pty_unavailable"),
  Type.Literal("pty_failed"),
  Type.Literal("input_too_large"),
  Type.Literal("output_overflow"),
]);
export type TerminalErrorCode = Static<typeof TerminalErrorCodeSchema>;

export const TerminalErrorSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("terminal.error"),
    error: Type.Object(
      {
        code: TerminalErrorCodeSchema,
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type TerminalError = Static<typeof TerminalErrorSchema>;

export const TerminalServerControlSchema = Type.Union([
  TerminalReadySchema,
  TerminalExitSchema,
  TerminalErrorSchema,
]);
export type TerminalServerControl = Static<typeof TerminalServerControlSchema>;
