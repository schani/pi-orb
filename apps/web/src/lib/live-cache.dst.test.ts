import type { OrbMessageView, ServerFrame } from "@pi-orb/protocol";
import type { Deadline } from "determined";
import { ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { initialState, reducer } from "../pages/OrbPage.tsx";
import { history } from "../testkit/transcript.ts";
import { devConsoleDebug } from "./dev-console-debug.ts";
import { createInboxPoller } from "./inbox-poller.ts";
import { openLiveConnection } from "./live.ts";
import { messagesAwaitingHistory } from "./queued-messages.ts";
import { TranscriptCache } from "./transcript-cache.ts";

it("DST: half-open offline/online recovers a parent-closed assistant suffix despite an empty inbox", async () => {
  await runDst({ name: "live-cache-half-open", iterations: 80 }, async (sim) => {
    // Only the platform boundary is modeled; the real client owns transport authority.
    class Socket {
      static OPEN = 1;
      static instances: Socket[] = [];
      readyState = Socket.OPEN;
      closeRequested = false;
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
        // Local close cannot complete on the broken transport; delivery is scheduler-owned.
        this.closeRequested = true;
      }
      frame(frame: ServerFrame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    const records = history("a", ["one", "two", "assistant-a", "assistant-b"]).records.map(
      (record) =>
        record.type === "message"
          ? {
              ...record,
              role: record.id === "two" ? ("user" as const) : ("assistant" as const),
              content: [{ type: "text" as const, text: "PRIVATE_FIXTURE_TEXT" }],
            }
          : record,
    );
    const recordFrame = (index: number): ServerFrame => {
      const record = records[index] ?? expect.fail("fixture record missing");
      return {
        v: 1,
        at: "now",
        type: "history.record",
        record,
        headId: record.id,
        retiredBlockIds: [],
      };
    };
    const welcome: ServerFrame = {
      v: 1,
      at: "now",
      type: "server.welcome",
      orbId: "a",
      sessionId: "session",
      connectionId: "connection",
      runtimeInstanceId: "runtime",
      capabilities: [],
      limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
    };
    let state = reducer(initialState("a"), { type: "history_loaded", view: history() });
    const assertTranscript = () => {
      const cached = cache.get("a");
      if (state.cacheReady) {
        expect(cached).toBeDefined();
        expect(cached?.records).toBe(state.records);
        expect(cached?.sessionId).toBe(state.sessionId);
        expect(cached?.afterRecordId).toBe(state.afterRecordId);
        expect(cached?.headId).toBe(state.headId);
      } else expect(cached).toBeUndefined();
      for (const snapshot of cached === undefined ? [state] : [state, cached]) {
        let parent: string | null = null;
        for (const [id, record] of snapshot.records) {
          expect(record.id).toBe(id);
          expect(record.parentId).toBe(parent);
          parent = id;
        }
        expect(snapshot.afterRecordId).toBe(parent);
        expect(snapshot.headId).toBe(parent);
      }
    };
    const publish = () => {
      if (state.cacheReady) expect(owner.publish(state)).toBe("stored");
      else owner.clear();
      assertTranscript();
    };
    publish();
    let retired!: () => void;
    const retirement = new Promise<void>((resolve) => {
      retired = resolve;
    });
    let helloSent!: () => void;
    const replacementHello = new Promise<void>((resolve) => {
      helloSent = resolve;
    });
    let synced!: () => void;
    const recovery = new Promise<void>((resolve) => {
      synced = resolve;
    });
    let live: ReturnType<typeof openLiveConnection> | undefined;
    let browser: EventTarget;
    const timers = new Map<number, Deadline>();
    let timerId = 0;
    const statuses: string[] = [];
    const acceptedRecords: string[] = [];
    let inboxPolls = 0;
    let inboxPublications = 0;
    let uiRows: OrbMessageView[] = [];
    let retiredFenced = true;
    try {
      vi.stubGlobal("WebSocket", Socket);
      const result = await sim.runTasks([
        {
          name: "browser-recovery",
          f: async (task) => {
            browser = Object.assign(new EventTarget(), {
              location: { protocol: "http:", host: "localhost" },
              setTimeout: (callback: () => void, delay: number) => {
                const id = ++timerId;
                const timer = task.createDeadline(delay, "browser retry timer");
                timers.set(id, timer);
                timer.signal.addEventListener(
                  "abort",
                  () => {
                    timers.delete(id);
                    callback();
                  },
                  { once: true },
                );
                return id;
              },
              clearTimeout: (id: number) => {
                timers.get(id)?.cancel();
                timers.delete(id);
              },
            });
            vi.stubGlobal("window", browser);
            live = openLiveConnection({
              orbId: "a",
              sessionId: state.sessionId,
              getAfterRecordId: () => state.afterRecordId,
              getVisible: () => true,
              onRequestLost: () => expect.fail("no pending commands"),
              onFrame: (frame) => {
                if (frame.type === "history.record") acceptedRecords.push(frame.record.id);
                state = reducer(state, { type: "frame", frame });
                publish();
              },
              onStatus: (status) => {
                statuses.push(status);
                state = reducer(state, { type: "connection_status", status });
                publish();
              },
            });
            const first = Socket.instances[0] ?? expect.fail("initial transport missing");
            first.onopen?.();
            first.frame(welcome);
            first.frame({
              v: 1,
              at: "now",
              type: "sync.started",
              mode: "after",
              afterRecordId: "one",
            });
            await task.checkpoint("advance applied cursor before connectivity loss");
            first.frame(recordFrame(1));
            first.frame({ v: 1, at: "now", type: "sync.completed", headId: "two" });
            expect(first.sent[0]?.afterRecordId).toBe("one");
            expect(cache.get("a")?.afterRecordId).toBe("two");
            browser.dispatchEvent(new Event("offline"));
            expect(first.readyState).toBe(Socket.OPEN);
            retired();
            // The assistant suffix is missed; one pre-outage received callback remains queued.
            await task.sleep(10_000, "offline interval without socket close delivery");
            expect(Socket.instances).toHaveLength(1);
            assertTranscript();
            browser.dispatchEvent(new Event("online"));
            await task.checkpoint("replacement open and latest cursor hello");
            const next = Socket.instances[1];
            next?.onopen?.();
            // Finish the schedule even without recovery, so the red trace replays on the fix.
            helloSent();
            next?.frame(welcome);
            await task.checkpoint("replacement sync starts");
            next?.frame({
              v: 1,
              at: "now",
              type: "sync.started",
              mode: "after",
              afterRecordId: "two",
            });
            for (const index of [2, 3]) {
              await task.checkpoint("ordered assistant replay", index);
              next?.frame(recordFrame(index));
            }
            next?.frame({ v: 1, at: "now", type: "sync.completed", headId: "assistant-b" });
            synced();
          },
        },
        {
          name: "retired-socket-delivery",
          f: async (task) => {
            await replacementHello;
            const old = Socket.instances[0] ?? expect.fail("initial transport missing");
            // A previously received record callback precedes the eventual close callback.
            // Never reorder messages on the replacement WebSocket.
            await task.checkpoint("queued old record callback");
            const before = state;
            const cached = cache.get("a");
            const beforeStatuses = [...statuses];
            old.frame(recordFrame(2));
            assertTranscript();
            retiredFenced &&=
              state === before &&
              cache.get("a") === cached &&
              JSON.stringify(statuses) === JSON.stringify(beforeStatuses);
            await task.checkpoint("old close callback against handshake or disposal");
            const beforeClose = state;
            const cachedClose = cache.get("a");
            if (old.closeRequested) {
              old.readyState = 3;
              old.onclose?.();
            }
            assertTranscript();
            retiredFenced &&= state === beforeClose && cache.get("a") === cachedClose;
          },
        },
        {
          name: "empty-inbox",
          f: async (task) => {
            await retirement;
            const poller = createInboxPoller(async (after, tracked) => {
              expect(after).toBe(0);
              expect(tracked).toEqual([]);
              await task.checkpoint("empty inbox response independent of history replay");
              inboxPolls++;
              return ok({ items: [], updates: [], cursor: 0 });
            });
            expect(
              (
                await poller.poll(
                  () => true,
                  (messages) => {
                    const before = state;
                    const cached = cache.get("a");
                    uiRows = messagesAwaitingHistory(messages, [...state.records.values()]);
                    inboxPublications++;
                    assertTranscript();
                    expect(state).toBe(before);
                    expect(cache.get("a")).toBe(cached);
                  },
                )
              )._unsafeUnwrap(),
            ).toEqual([]);
            expect(poller.rows()).toEqual([]);
            expect(uiRows).toEqual([]);
          },
        },
        {
          name: "dispose",
          f: async (task) => {
            await recovery;
            await task.checkpoint("dispose after completed replay");
            live?.dispose();
            owner.release();
            const before = state;
            const cached = cache.get("a");
            browser.dispatchEvent(new Event("offline"));
            browser.dispatchEvent(new Event("online"));
            Socket.instances[1]?.frame(recordFrame(2));
            Socket.instances[1]?.onclose?.();
            expect(state).toBe(before);
            expect(cache.get("a")).toBe(cached);
            assertTranscript();
          },
        },
      ]);
      if (result.isErr()) throw result.error;
      expect(
        Socket.instances
          .flatMap((socket) => socket.sent.filter((frame) => frame.type === "client.hello"))
          .map((frame) => frame.afterRecordId),
      ).toEqual(["one", "two"]);
      expect(retiredFenced).toBe(true);
      const ids = ["one", "two", "assistant-a", "assistant-b"];
      expect([...state.records.keys()]).toEqual(ids);
      expect([...(cache.get("a")?.records.keys() ?? [])]).toEqual(ids);
      assertTranscript();
      expect(state.afterRecordId).toBe("assistant-b");
      expect(state.headId).toBe("assistant-b");
      expect(acceptedRecords).toEqual(["two", "assistant-a", "assistant-b"]);
      expect(inboxPolls).toBe(1);
      expect(inboxPublications).toBe(1);
      expect(uiRows).toEqual([]);
      expect(Socket.instances).toHaveLength(2);
      expect(statuses.filter((status) => status === "closed")).toHaveLength(1);
      expect(timers.size).toBe(0);
      expect(JSON.stringify(devConsoleDebug.dump().trace)).not.toContain("PRIVATE_FIXTURE_TEXT");
    } finally {
      live?.dispose();
      for (const timer of timers.values()) timer.cancel();
      owner.release();
      vi.unstubAllGlobals();
    }
  });
});
