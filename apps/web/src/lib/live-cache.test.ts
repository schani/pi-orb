import type { ServerFrame } from "@pi-orb/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, reducer } from "../pages/OrbPage.tsx";
import { history } from "../testkit/transcript.ts";
import { openLiveConnection } from "./live.ts";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Socket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  frame(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const welcome = (sessionId: string): ServerFrame => ({
  v: 1,
  at: "now",
  type: "server.welcome",
  orbId: "a",
  sessionId,
  connectionId: "c",
  runtimeInstanceId: "new-runtime",
  capabilities: [],
  limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
});

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "cached session handshake: session replaced=%s; disposed transports cannot publish",
  (changed) => {
    Socket.instances = [];
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost" },
      setTimeout,
      clearTimeout,
    });
    let state = reducer(initialState("a"), { type: "history_loaded", view: history() });
    const live = openLiveConnection({
      orbId: "a",
      sessionId: state.sessionId,
      getAfterRecordId: () => state.afterRecordId,
      getVisible: () => true,
      onRequestLost: () => expect.fail("no pending request"),
      onFrame: (frame) => {
        state = reducer(state, { type: "frame", frame });
      },
      onStatus: (status) => {
        state = reducer(state, { type: "connection_status", status });
      },
    });
    const first = Socket.instances[0] ?? expect.fail("first socket missing");
    first.onopen?.();
    expect(first.sent[0]?.afterRecordId).toBe("one");
    first.frame(welcome(changed ? "replacement" : "session"));
    if (changed) {
      expect(first.readyState).toBe(3);
      expect(state.records.size).toBe(0);
      expect(state.cacheReady).toBe(false);
      const next = Socket.instances[1] ?? expect.fail("replacement socket missing");
      next.onopen?.();
      expect(next.sent[0]?.afterRecordId).toBeNull();
      next.frame(welcome("replacement"));
      expect(Socket.instances.length).toBe(2);
      // Even an old native callback after close cannot apply its old records.
      first.frame({
        v: 1,
        at: "now",
        type: "history.record",
        record: history().records[0] ?? expect.fail("fixture record missing"),
        headId: "one",
        retiredBlockIds: [],
      });
      expect(state.records.size).toBe(0);
      next.frame({ v: 1, at: "now", type: "sync.started", mode: "after", afterRecordId: null });
      next.frame({
        v: 1,
        at: "now",
        type: "history.record",
        record: history("a", ["new"]).records[0] ?? expect.fail("fixture record missing"),
        headId: "new",
        retiredBlockIds: [],
      });
      expect(state.cacheReady).toBe(false);
      next.frame({ v: 1, at: "now", type: "sync.completed", headId: "new" });
      expect(state.cacheReady).toBe(true);
      expect([...state.records.keys()]).toEqual(["new"]);
    } else {
      expect(Socket.instances.length).toBe(1);
      expect(state.records.has("one")).toBe(true);
    }
    live.dispose();
    const before = state;
    first.frame(welcome("late"));
    expect(state).toBe(before);
  },
);
