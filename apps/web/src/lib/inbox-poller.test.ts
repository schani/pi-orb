import type { OrbMessageListView, OrbMessageView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { ApiError } from "./api.ts";
import { createInboxPoller } from "./inbox-poller.ts";
import { withQueuedMessage } from "./queued-messages.ts";

const message: OrbMessageView = {
  id: "m1",
  orbId: "orb",
  content: [{ type: "image", mediaType: "image/png", data: "image" }],
  status: "queued",
  createdAt: "now",
  updatedAt: "now",
};
const delta: OrbMessageListView = { items: [message], updates: [], cursor: 7 };

it("keeps authoritative rows when React publication is delayed past the next poll", async () => {
  const fetch = vi.fn(async () => ok(delta) as Result<OrbMessageListView, ApiError>);
  const poller = createInboxPoller(fetch);
  const scheduled: OrbMessageView[][] = [];
  await poller.poll(
    () => true,
    (rows) => {
      scheduled.push(rows);
    },
  );
  fetch.mockResolvedValueOnce(ok({ items: [], updates: [], cursor: 7 }));
  // React has not rendered the first publication; the old rendered rows remain empty.
  const second = (
    await poller.poll(
      () => true,
      (rows) => {
        scheduled.push(rows);
      },
    )
  )._unsafeUnwrap();
  expect(second).toEqual([message]);
  expect(fetch).toHaveBeenLastCalledWith(7, ["m1"]);
  expect(scheduled).toEqual([[message], [message]]);
});

it("reuses authoritative rows and revisions when a metadata poll changes nothing", async () => {
  const fetch = vi.fn(async () => ok(delta) as Result<OrbMessageListView, ApiError>);
  const poller = createInboxPoller(fetch);
  await poller.poll(() => true);
  const first = poller.rows();
  const { content: _content, ...update } = message;
  fetch.mockResolvedValueOnce(ok({ items: [], updates: [update], cursor: 7 }));
  await poller.poll(() => true);
  expect(poller.rows()).toBe(first);
  expect(poller.rows()[0]).toBe(first[0]);
});

it("synchronously owns optimistic enqueue and history retirement independently of rendering", async () => {
  const fetch = vi.fn(async () => ok({ items: [], updates: [], cursor: 0 }));
  const poller = createInboxPoller(fetch);
  poller.update((rows) => [...rows, message]);
  await poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(0, ["m1"]);
  expect(poller.rows()).toEqual([message]);
  poller.update(() => []);
  await poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(0, []);
  expect(poller.rows()).toEqual([]);
});

it("singleflights, advances only accepted polls, tracks provisional IDs and merges late metadata", async () => {
  let finish!: (result: Result<OrbMessageListView, ApiError>) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Result<OrbMessageListView, ApiError>>((resolve) => {
        finish = resolve;
      }),
  );
  const poller = createInboxPoller(fetch);
  const first = poller.poll(() => false);
  expect((await poller.poll(() => true))._unsafeUnwrap()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  finish(ok(delta));
  expect((await first)._unsafeUnwrap()).toBeNull();
  const accepted = poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(0, []);
  finish(ok(delta));
  expect((await accepted)._unsafeUnwrap()).toEqual([message]);
  const next = poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(7, ["m1"]);
  const { content: _content, ...update } = message;
  finish(
    ok({
      items: [],
      updates: [{ ...update, status: "delivered", delivery: "steer", operationId: "late" }],
      cursor: 7,
    }),
  );
  expect((await next)._unsafeUnwrap()).toEqual([
    { ...message, status: "delivered", delivery: "steer", operationId: "late" },
  ]);
});

it("orders newly observed rows before a later optimistic row", async () => {
  const earlier = { ...message, id: "earlier" };
  const poller = createInboxPoller(async () =>
    ok({ items: [earlier, message], updates: [], cursor: 7 }),
  );
  poller.update(() => [message]);
  expect((await poller.poll(() => true))._unsafeUnwrap()?.map((row) => row.id)).toEqual([
    "earlier",
    "m1",
  ]);
});

it("preserves polled order and metadata when an enqueue acknowledgement arrives after cursor advancement", async () => {
  const delivered: OrbMessageView = {
    ...message,
    status: "delivered",
    delivery: "steer",
    operationId: "operation-m1",
    updatedAt: "later",
  };
  const later = { ...message, id: "m2" };
  const fetch = vi.fn(
    async () =>
      ok({ items: [delivered, later], updates: [], cursor: 7 }) as Result<
        OrbMessageListView,
        ApiError
      >,
  );
  const poller = createInboxPoller(fetch);
  await poller.poll(() => true);
  expect(poller.cursor()).toBe(7);

  // The PUT committed before the poll, but its queued acknowledgement arrives last.
  poller.update((rows) => withQueuedMessage(rows, message));
  expect(poller.rows().map((row) => row.id)).toEqual(["m1", "m2"]);
  expect(poller.rows()[0]).toBe(delivered);

  const { content: _content, ...update } = delivered;
  fetch.mockResolvedValueOnce(ok({ items: [], updates: [update], cursor: 7 }));
  await poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(7, ["m1", "m2"]);
  expect(poller.rows().map((row) => row.id)).toEqual(["m1", "m2"]);
  expect(poller.rows()[0]).toBe(delivered);
});

it("keeps optimistic rows, deduplicates new rows, and does not advance on error", async () => {
  const fetch = vi.fn(async () => ok(delta) as Result<OrbMessageListView, ApiError>);
  const poller = createInboxPoller(fetch);
  poller.update(() => [message]);
  expect((await poller.poll(() => true))._unsafeUnwrap()).toEqual([message]);
  fetch.mockResolvedValueOnce(err({ type: "network", message: "offline" }));
  expect((await poller.poll(() => true)).isErr()).toBe(true);
  await poller.poll(() => true);
  expect(fetch).toHaveBeenLastCalledWith(7, ["m1"]);
});
