import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  createRegistry,
  createSession,
  type DocumentId,
  type EntryId,
  Harness,
  NestedCallDoc,
  SessionFailed,
  type Storage,
  StorageRequestError,
  type TaskId,
  type ToolTaskResult,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, errAsync, ok } from "neverthrow";
import { expect, it, onTestFinished, vi } from "vitest";
import { PGliteClient } from "../pg/pglite-client.ts";
import { initializeBareAuthority } from "./bare-authority.testkit.ts";
import { PgDurableAuthority } from "./index.ts";
import { storageAuthorityError } from "./storage-boundary.ts";

const orb = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const db = new PGliteClient();
  await initializeBareAuthority(db, orb);
  let time = 0;
  return {
    db,
    authority: new PgDurableAuthority(db, () => time),
    setTime: (value: number) => {
      time = value;
    },
  };
}
it("rolls native history back when public projection rejects and recovers committed data without notification", async () => {
  const { db, authority } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const failed = (
      await authority.open(owner, {
        project: async () =>
          err({ type: "authority_error", code: "projection", message: "public conflict" }),
      })
    )._unsafeUnwrap();
    await expect(
      failed.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx),
    ).rejects.toBeDefined();
    expect(await failed.conversation(1 as ConversationId, ctx)).toBeUndefined();
    await failed.close(ctx);
    const storage = (
      await authority.open(owner, {
        project: async (query) => {
          const result = await query("CREATE TABLE committed_public(id integer PRIMARY KEY)");
          return result.isErr() ? err(result.error) : ok(undefined);
        },
        afterCommit: () => {
          /* notification deliberately lost */
        },
      })
    )._unsafeUnwrap();
    await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
    const reader = (await authority.read(orb))._unsafeUnwrap();
    expect(await reader.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
    await reader.close(ctx);
    await storage.close(ctx);
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});
it("fences expired owners and admission ABA while retaining independently sealed public data", async () => {
  const { db, authority, setTime } = await fixture();
  try {
    const old = (await authority.acquire(orb, "old", 0, 0, 10))._unsafeUnwrap();
    const storage = (
      await authority.open(old, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    expect((await authority.acquire(orb, "new", 0, 5, 15)).isErr()).toBe(true);
    setTime(10);
    const next = (await authority.acquire(orb, "new", 0, 10, 20))._unsafeUnwrap();
    await expect(
      storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx),
    ).rejects.toBeDefined();
    (
      await db.query("UPDATE orbs SET agent_admission_version=2 WHERE id=$1", [orb])
    )._unsafeUnwrap();
    expect((await authority.renew(next, 11, 30)).isErr()).toBe(true);
    await storage.close(ctx);
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});

it("rejects an invalid read without failing the Session", async () => {
  const { db, authority } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    const session = createSession(storage);
    try {
      await expect(
        session.commit((tx) => tx.scanEntries({ conversationId: 999 as ConversationId }, 1), ctx),
      ).rejects.toBeInstanceOf(StorageRequestError);
      const conversation = await session.commit(
        (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
        ctx,
      );
      expect(await storage.conversation(conversation.id, ctx)).toEqual(conversation);
    } finally {
      await session.close(ctx);
    }
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});

it.each(["read", "write"] as const)(
  "fails and closes the Session on %s IO, not an invalid request",
  async (operation) => {
    const { db, authority } = await fixture();
    const unavailable = {
      type: "store_error" as const,
      code: "unavailable" as const,
      message: "injected IO",
      retryable: true,
    };
    try {
      const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
      const storage = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      const session = createSession(storage);
      const spy =
        operation === "read"
          ? vi.spyOn(db, "query").mockReturnValueOnce(errAsync(unavailable))
          : vi.spyOn(db, "transaction");
      try {
        const failed =
          operation === "read"
            ? session.commit((tx) => tx.conversation(1 as ConversationId), ctx)
            : session.commit(async (tx) => {
                const conversation = await tx.createConversation({
                  ownership: { kind: "ownerless" },
                });
                spy.mockReturnValueOnce(errAsync(unavailable));
                return conversation;
              }, ctx);
        await expect(failed).rejects.not.toBeInstanceOf(StorageRequestError);
        await expect(session.commit(() => undefined, ctx)).rejects.toBeInstanceOf(SessionFailed);
        expect(await session.closed).toMatchObject({ reason: "failed" });
      } finally {
        spy.mockRestore();
        await session.close(ctx);
      }
    } finally {
      (await db.end())._unsafeUnwrap();
    }
  },
);

it("retains the typed owner fence through terminal SessionFailed", async () => {
  const { db, authority, setTime } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    const session = createSession(storage);
    setTime(10);
    (await authority.acquire(orb, "b", 0, 10, 20))._unsafeUnwrap();
    const first = await session
      .commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx)
      .catch((error: unknown) => error);
    expect(first).not.toBeInstanceOf(StorageRequestError);
    expect(storageAuthorityError(first)).toMatchObject({ code: "stale_owner" });
    const later = await session.commit(() => undefined, ctx).catch((error: unknown) => error);
    expect(later).toBeInstanceOf(SessionFailed);
    expect(storageAuthorityError(later)).toEqual(storageAuthorityError(first));
    expect(await session.closed).toMatchObject({ reason: "failed" });
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});

it("reopens completed 1.1 tool receipts and transcript content without rewriting them", async () => {
  const { db, authority } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    const entry = {
      id: 2 as EntryId,
      conversationId: 1 as ConversationId,
      kind: "pi.tool-result",
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult" as const,
          toolCallId: "old-call",
          toolName: "old-tool",
          content: [{ type: "text" as const, text: "completed 1.1" }],
          isError: false,
          timestamp: 1,
        },
      ],
    };
    const task = {
      id: 3 as TaskId<{ entryId: number }>,
      conversationId: 1 as ConversationId,
      kind: "pi.tool",
      version: 1,
      input: { assistant: 4, callId: "old-call" },
      background: false,
      abortRequested: false,
      state: {
        status: "terminal" as const,
        outcome: { status: "completed" as const, result: { entryId: 2 } },
      },
    };
    await storage.commit(
      [
        { type: "conversation", value: { id: 1 as ConversationId } },
        { type: "entry", value: entry },
        { type: "task", value: task },
      ],
      ctx,
    );
    await storage.close(ctx);
    const reopened = (
      await authority.open(owner, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    const harness = await Harness.open(
      reopened,
      {
        models: createModels(),
        registry: createRegistry(),
        env: () => new NodeExecutionEnv({ cwd: "/tmp" }),
      },
      ctx,
    );
    try {
      expect((await reopened.entry(entry.id, ctx))?.entry).toEqual(entry);
      expect(await reopened.task(task.id, ctx)).toEqual(task);
    } finally {
      await harness.close(ctx);
    }
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});

it("persists native nested-call task documents across reopen and retires their scoped incarnation", async () => {
  const { db, authority } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const open = async () =>
      (await authority.open(owner, { project: async () => ok(undefined) }))._unsafeUnwrap();
    const storage = await open();
    const taskId = 2 as TaskId<JsonValue>;
    await storage.commit(
      [
        { type: "conversation", value: { id: 1 as ConversationId } },
        {
          type: "task",
          value: {
            id: taskId,
            conversationId: 1 as ConversationId,
            kind: "pi.tool",
            version: 2,
            input: { kind: "model", assistant: 3, callId: "parent" },
            background: false,
            abortRequested: false,
            state: { status: "pending", checkpoint: { phase: "call" } },
          },
        },
      ],
      ctx,
    );
    const session = createSession(storage);
    await session.commit(async (tx) => {
      const call = await tx.doc(NestedCallDoc, taskId, "call-0", null);
      call.taskId = 4 as TaskId<ToolTaskResult>;
      call.result = {
        taskId: call.taskId,
        isError: false,
        structuredOutput: "nested",
        diagnostics: [],
      };
    }, ctx);
    await session.close(ctx);
    const reopened = await open();
    const resumed = createSession(reopened);
    try {
      expect(await resumed.snapshot(NestedCallDoc, taskId, "call-0", ctx)).toEqual({
        taskId: 4,
        result: { taskId: 4, isError: false, structuredOutput: "nested", diagnostics: [] },
      });
      expect(
        (
          await reopened.scanDocuments(
            { scope: { kind: "task", taskId }, at: "current" },
            10,
            undefined,
            ctx,
          )
        ).items,
      ).toHaveLength(1);
      await resumed.commit((tx) => tx.retireDoc(NestedCallDoc, taskId, "call-0"), ctx);
      expect(await resumed.snapshot(NestedCallDoc, taskId, "call-0", ctx)).toBeUndefined();
      expect(
        (
          await reopened.scanDocuments(
            { scope: { kind: "task", taskId }, at: "current" },
            10,
            undefined,
            ctx,
          )
        ).items,
      ).toHaveLength(0);
    } finally {
      await resumed.close(ctx);
    }
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});

it("isolates colliding native IDs through reads, replacement, retirement and archive", async () => {
  const { db, authority } = await fixture();
  onTestFinished(async () => {
    (await db.end())._unsafeUnwrap();
  });
  const storages: Storage[] = [];
  {
    const otherOrb = "00000000-0000-4000-8000-000000000002";
    (await db.query("INSERT INTO orbs(id) VALUES($1)", [otherOrb]))._unsafeUnwrap();
    const owners = await Promise.all(
      [orb, otherOrb].map(async (id) =>
        (await authority.acquire(id, "writer", 0, 0, 100))._unsafeUnwrap(),
      ),
    );
    const conversationId = 1 as ConversationId;
    const id = 2 as DocumentId;
    for (const [index, owner] of owners.entries()) {
      const storage = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      onTestFinished(() => storage.close(ctx));
      storages.push(storage);
      await storage.commit(
        [
          { type: "conversation", value: { id: conversationId } },
          {
            type: "document.create",
            record: {
              id,
              kind: "tenant",
              scope: { kind: "conversation", conversationId },
              history: "latest",
              fork: "current",
            },
            content: { kind: "base", version: 1, value: { tenant: index } },
          },
        ],
        ctx,
      );
    }
    const [a, b] = storages as [Storage, Storage];
    const original = await b.document(id, "current", ctx);
    expect(original?.value).toEqual({ tenant: 1 });
    expect(await a.conversation(conversationId, ctx)).toEqual({ id: conversationId });
    expect(await b.conversation(conversationId, ctx)).toEqual({ id: conversationId });
    expect((await a.document(id, "current", ctx))?.value).toEqual({ tenant: 0 });
    await a.commit(
      [
        {
          type: "document.change",
          id,
          content: { kind: "base", version: 1, value: { tenant: "changed" } },
        },
      ],
      ctx,
    );
    expect((await a.document(id, "current", ctx))?.value).toEqual({ tenant: "changed" });
    expect(await b.document(id, "current", ctx)).toEqual(original);
    await a.commit([{ type: "document.retire", id }], ctx);
    expect(await a.document(id, "current", ctx)).toBeUndefined();
    expect(await b.document(id, "current", ctx)).toEqual(original);
    expect(
      (
        await b.scanDocuments(
          { scope: { kind: "conversation", conversationId }, at: "current" },
          10,
          undefined,
          ctx,
        )
      ).items,
    ).toEqual([original?.record]);
    (await authority.archive(owners[0]!, async () => ok(undefined)))._unsafeUnwrap();
    expect(await a.conversation(conversationId, ctx)).toBeUndefined();
    expect(
      (await db.query("SELECT id FROM durable_pg_documents WHERE orb_id=$1", [orb]))._unsafeUnwrap()
        .rows,
    ).toEqual([]);
    expect(await b.conversation(conversationId, ctx)).toEqual({ id: conversationId });
    expect(await b.document(id, "current", ctx)).toEqual(original);
    expect((await authority.validate(owners[1]!)).isOk()).toBe(true);
  }
});
