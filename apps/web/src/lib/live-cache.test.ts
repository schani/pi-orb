import type { ClientAction, ServerFrame } from "@pi-orb/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, reducer } from "../pages/OrbPage.tsx";
import { history } from "../testkit/transcript.ts";
import { devConsoleDebug } from "./dev-console-debug.ts";
import { openLiveConnection } from "./live.ts";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  completeClose = true;
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
    if (!this.completeClose) return;
    this.readyState = 3;
    this.onclose?.();
  }
  frame(frame: ServerFrame) {
    this.raw(JSON.stringify(frame));
  }
  raw(data: string) {
    this.onmessage?.({ data });
  }
}
const welcome = (sessionId: string, runtimeInstanceId = "new-runtime"): ServerFrame => ({
  v: 1,
  at: "now",
  type: "server.welcome",
  orbId: "a",
  sessionId,
  connectionId: "c",
  runtimeInstanceId,
  capabilities: [],
  limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connectivityHarness() {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  const browser = Object.assign(new EventTarget(), {
    location: { protocol: "http:", host: "localhost" },
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("window", browser);
  let cursor = "one";
  const frames: ServerFrame[] = [];
  const statuses: string[] = [];
  const lost: { requestId: string; action: ClientAction }[] = [];
  const live = openLiveConnection({
    orbId: "a",
    sessionId: "session",
    getAfterRecordId: () => cursor,
    getVisible: () => true,
    onRequestLost: (requestId, action) => lost.push({ requestId, action }),
    onFrame: (frame) => frames.push(frame),
    onStatus: (status) => statuses.push(status),
  });
  const first = Socket.instances[0] ?? expect.fail("first socket missing");
  first.onopen?.();
  return {
    browser,
    live,
    first,
    frames,
    statuses,
    lost,
    advanceCursor: () => {
      cursor = "two";
    },
  };
}

it("offline relinquishes live authority; online replaces a half-open socket using the latest cursor", () => {
  const h = connectivityHarness();
  const lateOpen = h.first.onopen;
  const lateClose = h.first.onclose;
  const lateMessage = h.first.onmessage;
  h.first.completeClose = false;
  h.browser.dispatchEvent(new Event("offline"));
  expect(h.statuses.at(-1)).toBe("retrying");
  expect(h.first.readyState).toBe(Socket.OPEN);
  expect(h.live.sendRequest({ type: "abort", operationId: "operation" })).toBeNull();
  vi.advanceTimersByTime(10_000);
  expect(Socket.instances).toHaveLength(1);
  h.advanceCursor();
  h.browser.dispatchEvent(new Event("online"));
  expect(Socket.instances).toHaveLength(2);
  const next = Socket.instances[1] ?? expect.fail("replacement missing");
  next.onopen?.();
  expect(next.sent[0]?.afterRecordId).toBe("two");
  const beforeStatuses = [...h.statuses];
  const beforeSent = h.first.sent.length;
  lateOpen?.();
  lateClose?.();
  lateMessage?.({ data: JSON.stringify(welcome("session")) });
  expect(h.first.sent).toHaveLength(beforeSent);
  expect(h.frames).toEqual([]);
  expect(h.statuses).toEqual(beforeStatuses);
  vi.advanceTimersByTime(10_000);
  expect(Socket.instances).toHaveLength(2);
  expect(devConsoleDebug.dump().trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "connection", outcome: "browser_offline" }),
      expect.objectContaining({ event: "connection", outcome: "browser_online" }),
    ]),
  );
  h.live.dispose();
});

it.each(["same", "runtime_changed", "session_changed"] as const)(
  "half-open recovery preserves pending command ownership: %s",
  (change) => {
    const h = connectivityHarness();
    h.first.frame(welcome("session"));
    const action: ClientAction = { type: "abort", operationId: "operation" };
    const requestId = h.live.sendRequest(action) ?? expect.fail("request not sent");
    const original = h.first.sent.find((frame) => frame.type === "client.request");
    const lateResult = h.first.onmessage;
    h.first.completeClose = false;
    h.browser.dispatchEvent(new Event("offline"));
    expect(h.first.readyState).toBe(Socket.OPEN);
    h.browser.dispatchEvent(new Event("online"));
    const next = Socket.instances[1] ?? expect.fail("replacement missing");
    next.onopen?.();
    const beforeFrames = h.frames.length;
    lateResult?.({
      data: JSON.stringify({
        v: 1,
        at: "now",
        type: "request.result",
        requestId,
        result: { type: "accepted", operationId: "operation", duplicate: false },
      } satisfies ServerFrame),
    });
    expect(h.frames).toHaveLength(beforeFrames);
    next.frame(
      welcome(
        change === "session_changed" ? "replacement-session" : "session",
        change === "runtime_changed" ? "replacement-runtime" : "new-runtime",
      ),
    );
    const resends = next.sent.filter((frame) => frame.type === "client.request");
    if (change === "same") {
      expect(resends).toEqual([original]);
      expect(h.lost).toEqual([]);
    } else {
      expect(resends).toEqual([]);
      expect(h.lost).toEqual([{ requestId, action }]);
      if (change === "session_changed") {
        const fullSync = Socket.instances[2] ?? expect.fail("full sync transport missing");
        fullSync.onopen?.();
        expect(fullSync.sent[0]?.afterRecordId).toBeNull();
        fullSync.frame(welcome("replacement-session"));
        expect(fullSync.sent.filter((frame) => frame.type === "client.request")).toEqual([]);
        expect(h.lost).toEqual([{ requestId, action }]);
      }
    }
    h.live.dispose();
  },
);

it("online alone replaces an open socket and cancels an existing retry", () => {
  const h = connectivityHarness();
  h.browser.dispatchEvent(new Event("online"));
  expect(Socket.instances).toHaveLength(2);
  expect(h.first.readyState).toBe(3);
  const second = Socket.instances[1] ?? expect.fail("second socket missing");
  second.close();
  h.browser.dispatchEvent(new Event("online"));
  expect(Socket.instances).toHaveLength(3);
  vi.advanceTimersByTime(10_000);
  expect(Socket.instances).toHaveLength(3);
  h.live.dispose();
});

it("disposal removes connectivity listeners, cancels retries, and fences late socket callbacks", () => {
  const h = connectivityHarness();
  const remove = vi.spyOn(h.browser, "removeEventListener");
  const lateOpen = h.first.onopen;
  const lateClose = h.first.onclose;
  h.first.close();
  h.live.dispose();
  expect(remove).toHaveBeenCalledWith("offline", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("online", expect.any(Function));
  const before = [...h.statuses];
  h.browser.dispatchEvent(new Event("offline"));
  h.browser.dispatchEvent(new Event("online"));
  lateOpen?.();
  lateClose?.();
  vi.advanceTimersByTime(10_000);
  expect(Socket.instances).toHaveLength(1);
  expect(h.statuses).toEqual(before);
});

it.each([false, true])(
  "cached session handshake: session replaced=%s; disposed transports cannot publish",
  (changed) => {
    Socket.instances = [];
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: { protocol: "http:", host: "localhost" },
        setTimeout,
        clearTimeout,
      }),
    );
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
    expect(devConsoleDebug.dump().trace.at(-1)).toMatchObject({
      event: "connection",
      outcome: "open",
      connectionId: null,
    });
    expect(devConsoleDebug.dump().trace.at(-2)).toMatchObject({
      event: "connection",
      outcome: "hello",
      cursorAfter: "one",
    });
    first.raw("not json SECRET_FRAME_BODY");
    first.raw(JSON.stringify({ type: "history.record", content: "SECRET_FRAME_BODY" }));
    expect(first.sent[0]?.afterRecordId).toBe("one");
    const welcomedSession = changed ? "replacement" : "session";
    first.frame(welcome(welcomedSession));
    expect(
      devConsoleDebug
        .dump()
        .trace.findLast(
          (entry) => entry.frameType === "server.welcome" && entry.sessionId === welcomedSession,
        ),
    ).toMatchObject({
      event: "frame_received",
      connectionId: "c",
      runtimeInstanceId: "new-runtime",
    });
    if (changed) {
      expect(first.readyState).toBe(3);
      expect(state.records.size).toBe(0);
      expect(state.cacheReady).toBe(false);
      const next = Socket.instances[1] ?? expect.fail("replacement socket missing");
      next.onopen?.();
      expect(next.sent[0]?.afterRecordId).toBeNull();
      expect(devConsoleDebug.dump().trace.at(-2)).toMatchObject({
        event: "connection",
        outcome: "hello",
        cursorAfter: null,
      });
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
      expect(devConsoleDebug.dump().trace.at(-1)).toMatchObject({
        frameType: "sync.started",
        connectionId: "c",
        syncMode: "after",
      });
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
    const beforeStreaming = devConsoleDebug.dump();
    const activeSocket = changed
      ? (Socket.instances[1] ?? expect.fail("active socket missing"))
      : first;
    for (let revision = 1; revision <= 250; revision += 1) {
      activeSocket.frame({
        v: 1,
        at: "now",
        type: "runtime.event",
        event: {
          type: "output_patch",
          operationId: "operation",
          blockId: "block",
          blockType: "text",
          revision,
          patch: { type: "append", text: "SECRET_STREAM_CONTENT" },
        },
      });
    }
    const afterStreaming = devConsoleDebug.dump();
    expect(afterStreaming.trace).toHaveLength(beforeStreaming.trace.length);
    expect(afterStreaming.traceDropped).toBe(beforeStreaming.traceDropped);
    expect(JSON.stringify(afterStreaming.trace)).not.toContain("SECRET_STREAM_CONTENT");

    const diagnosticJson = JSON.stringify(afterStreaming.trace);
    expect(diagnosticJson).toContain("invalid_json");
    expect(diagnosticJson).toContain("schema_invalid");
    expect(diagnosticJson).not.toContain("SECRET_FRAME_BODY");
    expect(
      afterStreaming.trace.findLast((entry) => entry.outcome === "invalid_json"),
    ).toMatchObject({ textLength: "not json SECRET_FRAME_BODY".length });
    if (!changed) {
      const diagnosticRecord =
        history("a", ["diagnostic-record"]).records[0] ?? expect.fail("record missing");
      first.frame({
        v: 1,
        at: "now",
        type: "history.record",
        record: diagnosticRecord,
        headId: "diagnostic-record",
        retiredBlockIds: [],
      });
      expect(devConsoleDebug.dump().trace.at(-1)).toMatchObject({
        event: "frame_received",
        frameType: "history.record",
        recordId: "diagnostic-record",
        parentId: null,
        headId: "diagnostic-record",
        connectionId: "c",
      });
    }
    live.dispose();
    const before = state;
    first.frame(welcome("late"));
    expect(state).toBe(before);
  },
);
