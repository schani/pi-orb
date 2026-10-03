import type { DisplayRecord, OrbMessageListView, OrbMessageView } from "@pi-orb/protocol";
import { ok, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import type { ApiError } from "./api.ts";
import { createInboxPoller } from "./inbox-poller.ts";
import {
  createMutationEpoch,
  messagesAwaitingHistory,
  withQueuedMessage,
} from "./queued-messages.ts";

it("DST: enqueue/navigation fence reads, delivered survives until local history, empty deltas do not resurrect it", async () => {
  await runDst({ name: "inbox-delta-handoff", iterations: 30 }, async (sim) => {
    const old: OrbMessageView = {
      id: "old",
      orbId: "orb",
      content: [{ type: "text", text: "old" }],
      status: "delivered",
      createdAt: "now",
      updatedAt: "now",
    };
    const sent: OrbMessageView = { ...old, id: "sent", status: "queued" };
    let current: OrbMessageView[] = [];
    let active = true;
    let applied = false;
    let records: DisplayRecord[] = [];
    const epoch = createMutationEpoch();
    let resolve!: (result: Result<OrbMessageListView, ApiError>) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const poller = createInboxPoller(
      () =>
        new Promise((r) => {
          resolve = r;
          started();
        }),
    );
    const result = await sim.runTasks([
      {
        name: "poll",
        f: async (task) => {
          const token = epoch.begin();
          const pending = poller.poll(
            () => active && !epoch.isStale(token),
            (messages) => {
              applied = true;
              current = messagesAwaitingHistory(messages, records);
            },
          );
          await task.checkpoint("response publication");
          (await pending)._unsafeUnwrap();
        },
      },
      {
        name: "mutation",
        f: async (task) => {
          await ready;
          await task.checkpoint("enqueue accepted");
          epoch.commit();
          current = poller.update((rows) => withQueuedMessage(rows, sent));
          await task.checkpoint("navigate");
          active = false;
        },
      },
      {
        name: "response",
        f: async (task) => {
          await ready;
          await task.checkpoint("inbox snapshot completes");
          resolve(ok({ items: [old], updates: [], cursor: 4 }));
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(current.some((row) => row.id === "sent")).toBe(true);
    expect(poller.cursor()).toBe(applied ? 4 : 0);
    const fresh = createInboxPoller(async () => ok({ items: [old], updates: [], cursor: 4 }));
    current = (await fresh.poll(() => true))._unsafeUnwrap() ?? [];
    expect(messagesAwaitingHistory(current, records)).toEqual([old]);
    records = [
      {
        id: "native",
        parentId: null,
        timestamp: "now",
        type: "message",
        role: "user",
        content: [],
        inboxMessageIds: ["old"],
      },
    ];
    current = messagesAwaitingHistory(current, records);
    const empty = createInboxPoller(async () => ok({ items: [], updates: [], cursor: 4 }));
    empty.update(() => current);
    expect((await empty.poll(() => true))._unsafeUnwrap()).toEqual([]);
  });
});
