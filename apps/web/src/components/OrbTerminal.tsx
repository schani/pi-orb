import {
  TERMINAL_SUBPROTOCOL,
  type TerminalServerControl,
  TerminalServerControlSchema,
} from "@pi-orb/protocol";
import type { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import ghosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import { Terminal, useTerminal } from "@wterm/react";
import { ResultAsync } from "neverthrow";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "typebox/value";
import { snapTerminalSize } from "../lib/terminal-layout.ts";

const INITIAL_WIDTH = 552;
const INITIAL_HEIGHT = 391;
const EDGE_GAP = 18;
const COMPOSER_GAP = 14;
const HEADER_HEIGHT = 38;
const TERMINAL_HORIZONTAL_PADDING = 30;
const TERMINAL_VERTICAL_PADDING = 26;

interface GridMetrics {
  cellWidth: number;
  cellHeight: number;
  horizontalChrome: number;
  verticalChrome: number;
}

function terminalUrl(orbId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/orbs/${encodeURIComponent(orbId)}/terminal`;
}

function measureGrid(wt: WTerm): GridMetrics {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
  wt.element.append(probe);
  const cellWidth = Math.max(1, probe.getBoundingClientRect().width / 10);
  probe.remove();
  const styles = getComputedStyle(wt.element);
  const cellHeight = Number.parseFloat(styles.getPropertyValue("--term-row-height")) || 17;
  return {
    cellWidth,
    cellHeight,
    horizontalChrome: TERMINAL_HORIZONTAL_PADDING + 2,
    verticalChrome: HEADER_HEIGHT + TERMINAL_VERTICAL_PADDING + 2,
  };
}

function visibleGrid(wt: WTerm, metrics: GridMetrics): { cols: number; rows: number } {
  const styles = getComputedStyle(wt.element);
  const horizontalPadding =
    Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
  const verticalPadding =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  return {
    cols: Math.max(
      20,
      Math.floor((wt.element.clientWidth - horizontalPadding) / metrics.cellWidth),
    ),
    rows: Math.max(5, Math.floor((wt.element.clientHeight - verticalPadding) / metrics.cellHeight)),
  };
}

export function OrbTerminal({ orbId, enabled }: { orbId: string; enabled: boolean }) {
  const [started, setStarted] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [bottom, setBottom] = useState(96);
  const [size, setSize] = useState({ width: INITIAL_WIDTH, height: INITIAL_HEIGHT });
  const [grid, setGrid] = useState({ cols: 65, rows: 17 });
  const [status, setStatus] = useState<"connecting" | "connected" | "ended">("connecting");
  const [generation, setGeneration] = useState(0);
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ref, write, resize, focus } = useTerminal();
  const socketRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const metricsRef = useRef<GridMetrics>({
    cellWidth: 8,
    cellHeight: 18.6,
    horizontalChrome: TERMINAL_HORIZONTAL_PADDING + 2,
    verticalChrome: HEADER_HEIGHT + TERMINAL_VERTICAL_PADDING + 2,
  });
  const gridRef = useRef({ cols: 80, rows: 24 });

  useEffect(() => {
    if (!started || core !== null) return;
    let active = true;
    setStatus("connecting");
    setError(null);
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
  }, [core, started]);

  useEffect(() => {
    if (!enabled) return;
    const composer = document.querySelector<HTMLElement>(".composer");
    if (composer === null) return;
    const update = () =>
      setBottom(Math.ceil(composer.getBoundingClientRect().height + COMPOSER_GAP));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    if (enabled) return;
    socketRef.current?.close();
    socketRef.current = null;
    readyRef.current = false;
    setStarted(false);
    setHidden(true);
  }, [enabled]);

  useEffect(() => () => socketRef.current?.close(), []);

  const onReady = useCallback(
    (wt: WTerm) => {
      // React StrictMode may initialize an imperative child twice in development.
      // Replace rather than leak the earlier ephemeral PTY.
      socketRef.current?.close();
      readyRef.current = false;
      metricsRef.current = measureGrid(wt);
      const initialGrid = visibleGrid(wt, metricsRef.current);
      // Size the empty emulator before opening the PTY. Starting at wterm's
      // 80x24 default and auto-resizing after the prompt arrives makes its
      // bottom-anchored core place the first line partway down the viewport.
      wt.resize(initialGrid.cols, initialGrid.rows);
      gridRef.current = initialGrid;
      setGrid(initialGrid);
      const socket = new WebSocket(terminalUrl(orbId), TERMINAL_SUBPROTOCOL);
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
            focus();
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
    [focus, orbId, write],
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

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = size;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    let pendingGrid = gridRef.current;
    handle.setPointerCapture(pointerId);
    const move = (next: PointerEvent) => {
      const metrics = metricsRef.current;
      const snapped = snapTerminalSize({
        rawWidth: start.width - (next.clientX - startX),
        rawHeight: start.height - (next.clientY - startY),
        maxWidth: window.innerWidth - EDGE_GAP * 2,
        maxHeight: window.innerHeight - bottom - EDGE_GAP - 64,
        ...metrics,
      });
      pendingGrid = { cols: snapped.cols, rows: snapped.rows };
      setSize({ width: snapped.width, height: snapped.height });
    };
    const finish = () => {
      // Commit one terminal/PTY resize after the gesture. Reflowing wterm on
      // every pointer event races its scroll anchoring and makes text jump
      // unpredictably between the top and bottom while dragging.
      gridRef.current = pendingGrid;
      resize(pendingGrid.cols, pendingGrid.rows);
      setGrid(pendingGrid);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    // Listen on window rather than the resizing element: changing the panel's
    // box can cause browsers to retarget or lose element-level pointerup.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  if (!enabled) return null;
  if (!started) {
    return (
      <button
        type="button"
        className="orb-terminal-launcher"
        style={{ bottom }}
        title="Show terminal"
        aria-label="Show terminal"
        onClick={() => {
          setStarted(true);
          setHidden(false);
        }}
      >
        &gt;_
      </button>
    );
  }

  return (
    <>
      <aside
        className={`orb-terminal-window${hidden ? " orb-terminal-hidden" : ""}`}
        style={{ width: size.width, height: size.height, bottom }}
        aria-label="Interactive terminal"
      >
        <div className="orb-terminal-resize" onPointerDown={beginResize} />
        <header className="orb-terminal-header">
          <span className="orb-terminal-symbol">&gt;_</span>
          <span className="orb-terminal-title">terminal</span>
          <span className="orb-terminal-path">bash · /workspace/repo</span>
          <span className={`orb-terminal-status orb-terminal-status-${status}`}>● {status}</span>
          {status === "ended" ? (
            <button
              type="button"
              className="orb-terminal-restart"
              title="New terminal"
              aria-label="New terminal"
              onClick={() => {
                socketRef.current?.close();
                readyRef.current = false;
                setError(null);
                setStatus("connecting");
                setCore(null);
                setGeneration((value) => value + 1);
              }}
            >
              ↻
            </button>
          ) : (
            <button
              type="button"
              className="orb-terminal-clear"
              title="Clear terminal"
              aria-label="Clear terminal"
              onClick={() => sendInput("\f")}
            >
              ↺
            </button>
          )}
          <button
            type="button"
            className="orb-terminal-hide"
            title="Hide terminal"
            aria-label="Hide terminal"
            onClick={() => setHidden(true)}
          >
            −
          </button>
        </header>
        {error !== null && <div className="orb-terminal-error">{error}</div>}
        {core === null ? (
          <div className="orb-terminal-loading">loading terminal…</div>
        ) : (
          <Terminal
            key={generation}
            ref={ref}
            core={core}
            cols={grid.cols}
            rows={grid.rows}
            autoResize={false}
            style={{ height: "auto" }}
            cursorBlink
            onReady={onReady}
            onData={sendInput}
            onResize={sendResize}
            className="orb-terminal-emulator"
          />
        )}
      </aside>
      <button
        type="button"
        className={`orb-terminal-launcher${hidden ? " orb-terminal-launcher-visible" : ""}`}
        style={{ bottom }}
        title="Show terminal"
        aria-label="Show terminal"
        onClick={() => {
          setHidden(false);
          setTimeout(focus, 0);
        }}
      >
        &gt;_
      </button>
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
