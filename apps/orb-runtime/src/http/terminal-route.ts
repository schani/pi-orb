import {
  TERMINAL_MAX_INPUT_BYTES,
  TerminalClientControlSchema,
  type TerminalError,
  type TerminalErrorCode,
  type TerminalServerControl,
} from "@pi-orb/protocol";
import type { FastifyInstance } from "fastify";
import { Check } from "typebox/value";
import type { ManagedTerminal, TerminalManager } from "../terminal/manager.ts";

const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

export interface TerminalRouteDeps {
  readonly isReady: () => boolean;
  readonly manager: TerminalManager;
}

function errorControl(code: TerminalErrorCode, message: string, retryable: boolean): TerminalError {
  return { v: 1, type: "terminal.error", error: { code, message, retryable } };
}

/** Dedicated, ephemeral PTY socket; deliberately separate from agent history/live state. */
export function registerTerminalRoute(app: FastifyInstance, deps: TerminalRouteDeps): void {
  app.get("/v1/terminal", { websocket: true }, (socket) => {
    let terminal: ManagedTerminal | null = null;
    let opening = false;
    let closed = false;
    let removeData: (() => void) | null = null;
    let removeExit: (() => void) | null = null;

    const sendControl = (control: TerminalServerControl): void => {
      if (closed || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(control));
      } catch {
        socket.close(1011, "terminal control send failed");
      }
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      removeData?.();
      removeExit?.();
      removeData = null;
      removeExit = null;
      terminal?.close();
      terminal = null;
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (terminal === null) {
          sendControl(errorControl("not_ready", "terminal is not open", true));
          return;
        }
        if (data.byteLength > TERMINAL_MAX_INPUT_BYTES) {
          sendControl(errorControl("input_too_large", "terminal input frame is too large", false));
          return;
        }
        const written = terminal.write(data.toString("utf8"));
        if (written.isErr())
          sendControl(
            errorControl(written.error.code, written.error.message, written.error.retryable),
          );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        sendControl(errorControl("invalid_control", "terminal control is not JSON", false));
        return;
      }
      if (!Check(TerminalClientControlSchema, parsed)) {
        sendControl(errorControl("invalid_control", "invalid terminal control", false));
        return;
      }
      if (parsed.type === "terminal.resize") {
        if (terminal === null) {
          sendControl(errorControl("not_ready", "terminal is not open", true));
          return;
        }
        const resized = terminal.resize(parsed.cols, parsed.rows);
        if (resized.isErr())
          sendControl(
            errorControl(resized.error.code, resized.error.message, resized.error.retryable),
          );
        return;
      }
      if (terminal !== null || opening) {
        sendControl(errorControl("invalid_control", "terminal.open was already received", false));
        return;
      }
      if (!deps.isReady()) {
        sendControl(errorControl("not_ready", "runtime checkout is not ready", true));
        return;
      }

      opening = true;
      void deps.manager.open(parsed.cols, parsed.rows).then((opened) => {
        opening = false;
        if (closed) {
          if (opened.isOk()) opened.value.close();
          return;
        }
        if (opened.isErr()) {
          sendControl(
            errorControl(opened.error.code, opened.error.message, opened.error.retryable),
          );
          return;
        }
        terminal = opened.value;
        const dataSubscription = terminal.onData((output) => {
          if (closed || socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
            sendControl(
              errorControl("output_overflow", "terminal output consumer is too slow", true),
            );
            socket.close(1013, "terminal output overflow");
            cleanup();
            return;
          }
          try {
            socket.send(Buffer.from(output, "utf8"), { binary: true });
          } catch {
            socket.close(1011, "terminal output send failed");
            cleanup();
          }
        });
        const exitSubscription = terminal.onExit((exit) => {
          sendControl({ v: 1, type: "terminal.exit", ...exit });
          try {
            socket.close(1000, "terminal exited");
          } catch {
            cleanup();
          }
        });
        if (dataSubscription.isErr()) {
          sendControl(
            errorControl(
              dataSubscription.error.code,
              dataSubscription.error.message,
              dataSubscription.error.retryable,
            ),
          );
          cleanup();
          return;
        }
        removeData = dataSubscription.value;
        if (exitSubscription.isErr()) {
          sendControl(
            errorControl(
              exitSubscription.error.code,
              exitSubscription.error.message,
              exitSubscription.error.retryable,
            ),
          );
          cleanup();
          return;
        }
        removeExit = exitSubscription.value;
        sendControl({ v: 1, type: "terminal.ready", cols: parsed.cols, rows: parsed.rows });
      });
    });
  });
}
