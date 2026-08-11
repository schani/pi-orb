import type { OrbMessageListView, OrbMessageStatus, OrbMessageView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { ApiError } from "./api.ts";
import { createMutationEpoch, undeliveredMessages, withQueuedMessage } from "./queued-messages.ts";

const message = (id: string, status: OrbMessageStatus): OrbMessageView => ({
  id,
  orbId: "orb-1",
  content: [{ type: "text", text: id }],
  status,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

/** A promise whose resolution the test drives, so interleavings are exact. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type ListResult = Result<OrbMessageListView, ApiError>;
type EnqueueResult = Result<OrbMessageView, ApiError>;

/**
 * Mirrors the OrbPage wiring of the queued-message list: a 2s poll that
 * wholesale-replaces the array and an optimistic append after a committed
 * enqueue, both routed through the mutation epoch.
 */
function orbPageQueue() {
  const epoch = createMutationEpoch();
  let queued: OrbMessageView[] = [];
  let cancelled = false;
  return {
    get messages() {
      return queued;
    },
    unmount: () => {
      cancelled = true;
    },
    /** Starts a poll; the returned promise settles when the response is applied. */
    poll: (response: Promise<ListResult>): Promise<void> => {
      const token = epoch.begin();
      return response.then((result) => {
        if (cancelled || epoch.isStale(token) || result.isErr()) return;
        queued = undeliveredMessages(result.value.items);
      });
    },
    /** Starts an enqueue; commits the epoch and appends when it resolves. */
    send: (response: Promise<EnqueueResult>): Promise<void> =>
      response.then((result) => {
        if (result.isErr()) return;
        epoch.commit();
        queued = withQueuedMessage(queued, result.value);
      }),
  };
}

describe("queued message mutation epoch", () => {
  it("reports a read stale only once a mutation commits", () => {
    const epoch = createMutationEpoch();
    const token = epoch.begin();
    expect(epoch.isStale(token)).toBe(false);
    epoch.commit();
    expect(epoch.isStale(token)).toBe(true);
    expect(epoch.isStale(epoch.begin())).toBe(false);
  });

  it("keeps older in-flight reads stale after further mutations", () => {
    const epoch = createMutationEpoch();
    const first = epoch.begin();
    epoch.commit();
    const second = epoch.begin();
    epoch.commit();
    expect(epoch.isStale(first)).toBe(true);
    expect(epoch.isStale(second)).toBe(true);
  });
});

describe("queued message list updates", () => {
  it("drops delivered messages from the queue view", () => {
    expect(
      undeliveredMessages([
        message("a", "delivered"),
        message("b", "queued"),
        message("c", "delivering"),
        message("d", "failed"),
      ]).map((entry) => entry.id),
    ).toEqual(["b", "c", "d"]);
  });

  it("replaces an existing entry instead of duplicating it", () => {
    const queued = withQueuedMessage([message("a", "queued")], message("b", "queued"));
    const updated = withQueuedMessage(queued, message("b", "delivering"));
    expect(updated.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(updated[1]?.status).toBe("delivering");
  });
});

describe("queued message poll/enqueue race", () => {
  it("keeps the just-sent message when a poll started before the enqueue resolves after it", async () => {
    const queue = orbPageQueue();
    const list = deferred<ListResult>();
    const enqueue = deferred<EnqueueResult>();

    // 1. The poll request starts while the queue is still empty.
    const polled = queue.poll(list.promise);
    // 2. The enqueue commits and the optimistic append renders.
    enqueue.resolve(ok(message("m2", "queued")));
    await queue.send(enqueue.promise);
    expect(queue.messages.map((entry) => entry.id)).toEqual(["m2"]);
    // 3. The stale snapshot — taken before the enqueue — resolves last.
    list.resolve(ok({ items: [message("m1", "queued")] }));
    await polled;

    expect(queue.messages.map((entry) => entry.id)).toEqual(["m2"]);
  });

  it("applies a poll that started after the enqueue committed", async () => {
    const queue = orbPageQueue();
    const enqueue = deferred<EnqueueResult>();
    enqueue.resolve(ok(message("m2", "queued")));
    await queue.send(enqueue.promise);

    const list = deferred<ListResult>();
    const polled = queue.poll(list.promise);
    list.resolve(ok({ items: [message("m1", "delivered"), message("m2", "delivering")] }));
    await polled;

    expect(queue.messages.map((entry) => entry.id)).toEqual(["m2"]);
    expect(queue.messages[0]?.status).toBe("delivering");
  });

  it("discards a stale poll but lets the following poll reconcile the queue", async () => {
    const queue = orbPageQueue();
    const stale = deferred<ListResult>();
    const stalePolled = queue.poll(stale.promise);
    const enqueue = deferred<EnqueueResult>();
    enqueue.resolve(ok(message("m2", "queued")));
    await queue.send(enqueue.promise);
    stale.resolve(ok({ items: [] }));
    await stalePolled;

    const fresh = deferred<ListResult>();
    const freshPolled = queue.poll(fresh.promise);
    fresh.resolve(ok({ items: [message("m2", "delivered"), message("m3", "queued")] }));
    await freshPolled;

    expect(queue.messages.map((entry) => entry.id)).toEqual(["m3"]);
  });

  it("leaves the queue untouched on a failed poll or a failed enqueue", async () => {
    const queue = orbPageQueue();
    const seed = deferred<ListResult>();
    const seeded = queue.poll(seed.promise);
    seed.resolve(ok({ items: [message("m1", "queued")] }));
    await seeded;

    const failedEnqueue = deferred<EnqueueResult>();
    failedEnqueue.resolve(
      err({ type: "http", status: 503, code: null, message: "unavailable", retryable: true }),
    );
    await queue.send(failedEnqueue.promise);

    const failedPoll = deferred<ListResult>();
    const polled = queue.poll(failedPoll.promise);
    failedPoll.resolve(err({ type: "network", message: "offline" }));
    await polled;

    expect(queue.messages.map((entry) => entry.id)).toEqual(["m1"]);
  });

  it("ignores a poll that resolves after the page unmounted", async () => {
    const queue = orbPageQueue();
    const list = deferred<ListResult>();
    const polled = queue.poll(list.promise);
    queue.unmount();
    list.resolve(ok({ items: [message("m1", "queued")] }));
    await polled;

    expect(queue.messages).toEqual([]);
  });
});
