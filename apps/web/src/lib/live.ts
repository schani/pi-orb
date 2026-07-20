import { generateUuid } from "./uuid.ts";
import { Check } from "typebox/value";
import {
  RUNTIME_SUBPROTOCOL,
  ServerFrameSchema,
  type ClientAction,
  type ClientHello,
  type ClientRequest,
  type ServerFrame,
} from "@pi-orb/protocol";

/** Stable UUID for this browser tab (DESIGN §6.2). */
export const CLIENT_INSTANCE_ID: string = generateUuid();

export type LiveConnectionStatus = "connecting" | "open" | "retrying" | "closed";

export interface LiveConnectionOptions {
  orbId: string;
  /** Last complete record id applied by the UI; re-read on every (re)connect. */
  getAfterRecordId: () => string | null;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: LiveConnectionStatus) => void;
  /**
   * An unacknowledged request was dropped because the runtime instance
   * changed across a reconnect, so auto-resending is unsafe (DESIGN §6.4).
   */
  onRequestLost: (requestId: string, action: ClientAction) => void;
}

export interface LiveConnection {
  /** Returns the request id, or null when the socket is not open. */
  sendRequest: (action: ClientAction) => string | null;
  dispose: () => void;
}

const RETRY_DELAY_MS = 2000;

interface PendingRequest {
  frame: ClientRequest;
  /** Runtime instance that received the original send, if known. */
  runtimeInstanceId: string | null;
}

/**
 * WebSocket state machine for one orb's live channel: hello/sync handshake,
 * frame validation, 2s reconnect backoff (including 1013 "try again later"),
 * and instance-guarded resend of unacknowledged requests.
 */
export function openLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${window.location.host}/api/v1/orbs/${encodeURIComponent(
    options.orbId,
  )}/live`;

  let socket: WebSocket | null = null;
  let disposed = false;
  let retryTimer: number | null = null;
  let runtimeInstanceId: string | null = null;
  const pending = new Map<string, PendingRequest>();

  function scheduleRetry(): void {
    if (disposed) return;
    options.onStatus("retrying");
    retryTimer = window.setTimeout(connect, RETRY_DELAY_MS);
  }

  function handleFrame(ws: WebSocket, frame: ServerFrame): void {
    if (frame.type === "server.welcome") {
      const newInstanceId = frame.runtimeInstanceId;
      for (const [requestId, entry] of [...pending.entries()]) {
        if (entry.runtimeInstanceId === newInstanceId) {
          // Same runtime process: identical request id + action is a safe
          // duplicate and returns the original result (DESIGN §6.4).
          ws.send(JSON.stringify(entry.frame));
        } else {
          pending.delete(requestId);
          options.onRequestLost(requestId, entry.frame.action);
        }
      }
      runtimeInstanceId = newInstanceId;
    } else if (frame.type === "request.result") {
      pending.delete(frame.requestId);
    }
    options.onFrame(frame);
  }

  function connect(): void {
    if (disposed) return;
    retryTimer = null;
    options.onStatus("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, RUNTIME_SUBPROTOCOL);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (ws !== socket) return;
      const hello: ClientHello = {
        v: 1,
        type: "client.hello",
        clientInstanceId: CLIENT_INSTANCE_ID,
        afterRecordId: options.getAfterRecordId(),
      };
      ws.send(JSON.stringify(hello));
      options.onStatus("open");
    };

    ws.onmessage = (event: MessageEvent) => {
      if (ws !== socket) return;
      const data: unknown = event.data;
      if (typeof data !== "string") return; // binary frames are not part of the protocol
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // ignore malformed frames
      }
      // Ignore frames failing validation; well-formed unknown event types
      // also fail the closed-union check and are ignored the same way.
      if (!Check(ServerFrameSchema, parsed)) return;
      handleFrame(ws, parsed);
    };

    ws.onclose = () => {
      if (ws !== socket) return;
      socket = null;
      if (disposed) {
        options.onStatus("closed");
      } else {
        // Covers 1013 "try again later" and any other close cause; the page
        // disposes this connection once the orb is no longer running.
        scheduleRetry();
      }
    };
  }

  connect();

  return {
    sendRequest: (action: ClientAction): string | null => {
      const ws = socket;
      if (ws === null || ws.readyState !== WebSocket.OPEN) return null;
      const requestId = generateUuid();
      const frame: ClientRequest = { v: 1, type: "client.request", requestId, action };
      pending.set(requestId, { frame, runtimeInstanceId });
      ws.send(JSON.stringify(frame));
      return requestId;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      const ws = socket;
      socket = null;
      if (ws !== null) {
        ws.onclose = null;
        ws.close();
      }
      options.onStatus("closed");
    },
  };
}
