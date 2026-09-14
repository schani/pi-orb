import {
  TERMINAL_SUBPROTOCOL,
  type TerminalServerControl,
  TerminalServerControlSchema,
} from "@pi-orb/protocol";
import type { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import ghosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import { Terminal, useTerminal } from "@wterm/react";
import { Result, ResultAsync } from "neverthrow";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "typebox/value";
import { normalizeTerminalSelection } from "../lib/terminal-copy.ts";
import { type TerminalGridMetrics, terminalShadeLayout } from "../lib/terminal-layout.ts";
import { Icon } from "./Icons.tsx";

const HORIZONTAL_PADDING = 30;
const VERTICAL_PADDING = 26;
const INITIAL_METRICS: TerminalGridMetrics = {
  cellWidth: 8,
  cellHeight: 20,
  horizontalChrome: HORIZONTAL_PADDING + 2,
  verticalChrome: VERTICAL_PADDING + 2,
};

function terminalUrl(orbId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/orbs/${encodeURIComponent(orbId)}/terminal`;
}

function measureGrid(wt: WTerm): TerminalGridMetrics {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
  wt.element.append(probe);
  const cellWidth = Math.max(1, probe.getBoundingClientRect().width / 10);
  probe.remove();
  const styles = getComputedStyle(wt.element);
  return {
    ...INITIAL_METRICS,
    cellWidth,
    cellHeight: Number.parseFloat(styles.getPropertyValue("--term-row-height")) || 20,
  };
}

function copySelection(event: React.ClipboardEvent<HTMLDivElement>): void {
  const grid = event.currentTarget.querySelector(".term-grid");
  const selection = window.getSelection();
  if (
    grid === null ||
    selection === null ||
    selection.isCollapsed ||
    !grid.contains(selection.anchorNode) ||
    !grid.contains(selection.focusNode)
  ) {
    return;
  }
  event.clipboardData.setData("text/plain", normalizeTerminalSelection(selection.toString()));
  event.preventDefault();
}

/** Render directly in the orb header's shared action row. */
export function OrbTerminal({ orbId, enabled }: { orbId: string; enabled: boolean }) {
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState(false);
  const [bounds, setBounds] = useState({ width: 552, availableHeight: 400 });
  const [metrics, setMetrics] = useState(INITIAL_METRICS);
  const [preferredRows, setPreferredRows] = useState<number>();
  const [previewRows, setPreviewRows] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startRows: number;
    rows: number;
    handle: HTMLHRElement;
  } | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "ended">("connecting");
  const [generation, setGeneration] = useState(0);
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ref, write, focus } = useTerminal();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const openRef = useRef(open);
  const boundsRef = useRef(bounds);
  openRef.current = open;
  boundsRef.current = bounds;
  const preferredRowsRef = useRef(preferredRows);
  preferredRowsRef.current = preferredRows;
  const layout = terminalShadeLayout(bounds, metrics, preferredRows);
  const preview = previewRows === null ? layout : terminalShadeLayout(bounds, metrics, previewRows);
  const gridRef = useRef({ cols: layout.cols, rows: layout.rows });
  const panelId = `orb-terminal-${orbId}`;

  useLayoutEffect(() => {
    if (!enabled) return;
    const header = buttonRef.current?.closest<HTMLElement>(".orb-header");
    const composer = header?.closest(".orb-main")?.querySelector<HTMLElement>(".composer");
    if (!header || !composer) return;
    const update = () => {
      const headerBox = header.getBoundingClientRect();
      const next = {
        width: headerBox.width + 1,
        availableHeight: Math.max(
          0,
          Math.min(window.innerHeight, composer.getBoundingClientRect().top) - headerBox.bottom + 1,
        ),
      };
      setBounds((current) =>
        current.width === next.width && current.availableHeight === next.availableHeight
          ? current
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(composer);
    observer.observe(document.body);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must reload even when a failed load left core null.
  useEffect(() => {
    if (!enabled || !started || core !== null) return;
    let active = true;
    void ResultAsync.fromPromise(
      GhosttyCore.load({ wasmPath: ghosttyWasmUrl, scrollbackLimit: 1024 * 1024 }),
      (cause) => `Terminal emulator failed to load: ${String(cause)}`,
    ).then((result) => {
      if (!active) return;
      if (result.isOk()) setCore(result.value);
      else {
        setStatus("ended");
        setError(result.error);
      }
    });
    return () => {
      active = false;
    };
  }, [core, enabled, started, generation]);

  useEffect(() => {
    if (enabled) return;
    socketRef.current?.close();
    socketRef.current = null;
    readyRef.current = false;
    setStarted(false);
    setOpen(false);
    setCore(null);
    setError(null);
    setStatus("connecting");
  }, [enabled]);

  useEffect(() => () => socketRef.current?.close(), []);

  useLayoutEffect(() => {
    if (open && readyRef.current) focus();
  }, [focus, open]);

  const finishResize = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (commit && drag) setPreferredRows(drag.rows);
    setPreviewRows(null);
    if (drag?.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }, []);

  useEffect(() => {
    if (!open || !enabled) finishResize(false);
  }, [enabled, finishResize, open]);

  const toggle = useCallback(() => {
    if (openRef.current) {
      openRef.current = false;
      setOpen(false);
      const previous = returnFocusRef.current;
      (previous?.isConnected ? previous : buttonRef.current)?.focus({ preventScroll: true });
    } else {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      openRef.current = true;
      setStarted(true);
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key.toLowerCase() !== "j" ||
        buttonRef.current?.closest("[inert]")
      )
        return;
      // Capture before wterm so the toggle cannot also become terminal input.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, toggle]);

  const onReady = useCallback(
    (wt: WTerm) => {
      // A destroyed StrictMode instance can finish init after its DOM node
      // has been reused. Only the currently owned emulator may open a PTY.
      if (ref.current?.instance !== wt || !wt.element.isConnected) return;
      socketRef.current?.close();
      readyRef.current = false;
      const measured = measureGrid(wt);
      const initial = terminalShadeLayout(boundsRef.current, measured, preferredRowsRef.current);
      // Size before opening the PTY so its first prompt starts on the first
      // row. The emulator viewport must always contain whole rows.
      wt.resize(initial.cols, initial.rows);
      gridRef.current = { cols: initial.cols, rows: initial.rows };
      setMetrics(measured);
      const connected = Result.fromThrowable(
        () => new WebSocket(terminalUrl(orbId), TERMINAL_SUBPROTOCOL),
        () => "Terminal connection failed.",
      )();
      if (connected.isErr()) {
        setStatus("ended");
        setError(connected.error);
        return;
      }
      const socket = connected.value;
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      setStatus("connecting");
      setError(null);
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        const { cols, rows } = gridRef.current;
        socket.send(JSON.stringify({ v: 1, type: "terminal.open", cols, rows }));
      };
      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        if (event.data instanceof ArrayBuffer) {
          write(new Uint8Array(event.data));
          return;
        }
        let control: unknown;
        try {
          control = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!Check(TerminalServerControlSchema, control)) return;
        handleControl(
          control,
          write,
          () => {
            readyRef.current = true;
            setStatus("connected");
            if (openRef.current) focus();
          },
          (message) => {
            readyRef.current = false;
            setStatus("ended");
            setError(message);
          },
        );
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        readyRef.current = false;
        setStatus("ended");
        setError((current) => current ?? "Terminal connection closed.");
      };
      socket.onerror = () => {
        if (socketRef.current === socket) setError("Terminal connection failed.");
      };
    },
    [focus, orbId, ref, write],
  );

  const sendInput = useCallback((data: string) => {
    const socket = socketRef.current;
    if (readyRef.current && socket?.readyState === WebSocket.OPEN) {
      socket.send(new TextEncoder().encode(data));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    gridRef.current = { cols, rows };
    const socket = socketRef.current;
    if (readyRef.current && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ v: 1, type: "terminal.resize", cols, rows }));
    }
  }, []);

  if (!enabled) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button"
        aria-label={open ? "Hide terminal" : "Open terminal"}
        title={`${open ? "Hide terminal" : "Open terminal"} (⌘J)`}
        aria-keyshortcuts="Meta+J"
        aria-controls={started ? panelId : undefined}
        aria-expanded={open}
        aria-pressed={open}
        onClick={toggle}
      >
        <Icon name="terminal" />
      </button>
      {started && (
        <aside
          id={panelId}
          className={`orb-terminal-window${open ? "" : " orb-terminal-hidden"}`}
          style={{ height: preview.height }}
          aria-label="Interactive terminal"
          aria-hidden={!open}
          inert={!open}
        >
          <div className="orb-terminal-body">
            {error !== null && (
              <div className="orb-terminal-error" role="alert">
                {error}
                {status === "ended" && (
                  <button
                    type="button"
                    onClick={() => {
                      socketRef.current?.close();
                      socketRef.current = null;
                      readyRef.current = false;
                      setError(null);
                      setStatus("connecting");
                      setCore(null);
                      setGeneration((value) => value + 1);
                    }}
                  >
                    New terminal
                  </button>
                )}
              </div>
            )}
            {status === "connecting" && (
              <div className="orb-terminal-loading" role="status">
                {core === null ? "loading terminal…" : "connecting terminal…"}
              </div>
            )}
            {core !== null && (
              <Terminal
                key={generation}
                ref={ref}
                core={core}
                cols={layout.cols}
                rows={layout.rows}
                autoResize={false}
                style={{ height: layout.rows * metrics.cellHeight }}
                cursorBlink
                onReady={onReady}
                onData={sendInput}
                onResize={sendResize}
                onError={(cause) => {
                  socketRef.current?.close();
                  socketRef.current = null;
                  readyRef.current = false;
                  setStatus("ended");
                  setError(`Terminal emulator failed: ${String(cause)}`);
                }}
                onCopy={copySelection}
                className="orb-terminal-emulator"
              />
            )}
          </div>
          <hr
            className="orb-terminal-resize"
            tabIndex={0}
            aria-label="Resize terminal"
            aria-orientation="horizontal"
            aria-valuemin={5}
            aria-valuemax={layout.maxRows}
            aria-valuenow={preview.rows}
            aria-valuetext={`${preview.rows} rows`}
            onPointerDown={(event) => {
              if (event.button !== 0 || dragRef.current !== null) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startRows: layout.rows,
                rows: layout.rows,
                handle: event.currentTarget,
              };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const requested =
                drag.startRows + Math.round((event.clientY - drag.startY) / metrics.cellHeight);
              drag.rows = terminalShadeLayout(bounds, metrics, requested).rows;
              setPreviewRows(drag.rows);
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishResize(true);
            }}
            onPointerCancel={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishResize(false);
            }}
            onLostPointerCapture={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishResize(false);
            }}
            onKeyDown={(event) => {
              const rows =
                event.key === "ArrowUp"
                  ? layout.rows - 1
                  : event.key === "ArrowDown"
                    ? layout.rows + 1
                    : event.key === "Home"
                      ? 5
                      : event.key === "End"
                        ? layout.maxRows
                        : null;
              if (rows === null || dragRef.current) return;
              event.preventDefault();
              setPreferredRows(terminalShadeLayout(bounds, metrics, rows).rows);
            }}
          />
        </aside>
      )}
    </>
  );
}

function handleControl(
  control: TerminalServerControl,
  write: (data: string | Uint8Array) => void,
  ready: () => void,
  ended: (message: string) => void,
): void {
  if (control.type === "terminal.ready") {
    ready();
  } else if (control.type === "terminal.exit") {
    write(`\r\n\x1b[90m[terminal exited ${control.exitCode}]\x1b[0m\r\n`);
    ended(`Terminal exited with code ${control.exitCode}.`);
  } else {
    ended(control.error.message);
  }
}
