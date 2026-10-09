import type { OrbMessageListView } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("inbox deltas", false);
const url = "/api/v1/orbs/orb-inbox/messages";
const pollUrl = `${url}/poll`;
const messageId = "00000000-0000-4000-8000-000000000042";

describe("inbox incremental reads", () => {
  let harness: ReturnType<typeof makeHarness>;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project-inbox"));
    harness.store.seedOrb(makeOrbRow("orb-inbox", "project-inbox", "stopped"));
    app = Fastify();
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    await app.ready();
    const enqueued = await app.inject({
      method: "PUT",
      url: `${url}/${messageId}`,
      payload: {
        content: [{ type: "image", mediaType: "image/png", data: "A".repeat(2_320_000) }],
      },
    });
    expect(enqueued.statusCode).toBe(202);
  });
  afterEach(async () => {
    await app.close();
  });
  const poll = (after = 0, tracked: string[] = []) =>
    app.inject({ method: "POST", url: pollUrl, payload: { after, tracked } });

  it("bootstraps content once and tracks late delivered metadata without repeating images", async () => {
    const first = await poll();
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.body.length).toBeGreaterThan(2_320_000);
    expect(first.json().cursor).toBeGreaterThan(0);
    await harness.store.noteOrbMessageDelivery(task, {
      orbId: "orb-inbox",
      messageIds: [messageId],
      delivery: "steer",
      operationId: "late-operation",
      now: task.wallNow(),
    });
    const delta = await poll(first.json().cursor, [messageId]);
    expect(delta.json().items).toEqual([]);
    expect(delta.json().updates).toMatchObject([
      { id: messageId, status: "delivering", delivery: "steer", operationId: "late-operation" },
    ]);
    expect(delta.json().updates[0]).not.toHaveProperty("content");
    expect(delta.json().cursor).toBe(first.json().cursor);
    expect(delta.body.length).toBeLessThan(1000);
  });

  it("returns only new rows, including equal-timestamp inserts, and a same-snapshot cursor", async () => {
    const first = await poll();
    expect(first.statusCode).toBe(200);
    const previous = harness.store.messageSnapshots("orb-inbox")[0];
    (
      await harness.store.enqueueOrbMessage(task, {
        orbId: "orb-inbox",
        messageId: "00000000-0000-4000-8000-000000000043",
        content: [{ type: "text", text: "next" }],
        now: previous?.createdAt ?? 0,
      })
    )._unsafeUnwrap();
    const changed = await poll(first.json().cursor);
    expect(changed.json().items).toMatchObject([{ content: [{ type: "text", text: "next" }] }]);
    expect(changed.json().items).toHaveLength(1);
    expect(changed.json().cursor).toBeGreaterThan(first.json().cursor);
    expect((await poll(changed.json().cursor)).json()).toEqual({
      items: [],
      updates: [],
      cursor: changed.json().cursor,
    });
  });

  it("polls 420 failed IDs over real HTTP without putting selectors in the URL", async () => {
    const ids = Array.from(
      { length: 420 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
    );
    for (const id of ids)
      (
        await harness.store.enqueueOrbMessage(task, {
          orbId: "orb-inbox",
          messageId: id,
          content: [{ type: "text", text: "failed" }],
          now: task.wallNow(),
        })
      )._unsafeUnwrap();
    const batch = (
      await harness.store.claimNextOrbMessageBatch(task, {
        orbId: "orb-inbox",
        now: task.wallNow(),
      })
    )._unsafeUnwrap();
    (
      await harness.store.failOrbMessageBatch(task, {
        orbId: "orb-inbox",
        deliveryBatchId: batch[0]!.deliveryBatchId!,
        messageIds: ids,
        lastError: "rejected",
        now: task.wallNow(),
      })
    )._unsafeUnwrap();
    const first = await poll();
    expect(first.statusCode).toBe(200);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${origin}${pollUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ after: first.json().cursor, tracked: ids }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrbMessageListView;
    expect(body.items).toEqual([]);
    expect(body.updates).toHaveLength(420);
    expect(
      body.updates.every(
        (update: { status: string; content?: unknown }) =>
          update.status === "failed" && update.content === undefined,
      ),
    ).toBe(true);
  });

  it.each([
    { after: -1, tracked: [] },
    { after: 1.5, tracked: [] },
    { after: 9007199254740992, tracked: [] },
    { after: 0, tracked: ["not-a-uuid"] },
  ])("rejects invalid selector %j", async (body) => {
    expect((await app.inject({ method: "POST", url: pollUrl, payload: body })).statusCode).toBe(
      400,
    );
  });
});
