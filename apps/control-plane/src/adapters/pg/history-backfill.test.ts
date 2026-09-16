import { type HistoryRecord, HistoryRecordSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapPiEntry } from "../../../../orb-runtime/src/pi/mapping.ts";
import { jsonParam } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { PGliteClient } from "./pglite-client.ts";

/**
 * Clients read typed record fields, so transcripts persisted before those
 * fields existed must gain them from the native blob they were mapped from
 * (docs/pi-adapter.md). The backfill must derive exactly what the Pi adapter
 * derives, so both run over the same native entries here and must agree.
 */
const BACKFILL = "022_typed_history_fields.sql";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORB = "22222222-2222-4222-8222-222222222222";

const entry = (id: string, native: Record<string, unknown>): Record<string, unknown> => ({
  id,
  parentId: null,
  timestamp: "2026-07-20T10:00:00.000Z",
  ...native,
});

/** Native Pi entries: every derivation, plus the shapes that could break one. */
const entries: Record<string, unknown>[] = [
  entry("shell", {
    type: "message",
    message: {
      role: "bashExecution",
      command: "npm test",
      output: "passing",
      exitCode: 2,
      cancelled: false,
      truncated: true,
      excludeFromContext: true,
    },
  }),
  entry("shell-cancelled", {
    type: "message",
    message: { role: "bashExecution", command: "sleep 10" },
  }),
  entry("shell-nonstring-output", {
    type: "message",
    message: { role: "bashExecution", command: 7, output: { chunks: [] }, exitCode: "2" },
  }),
  entry("custom-shown", {
    type: "custom_message",
    customType: "my-ext",
    content: "note",
    display: true,
  }),
  entry("custom-hidden", { type: "custom_message", customType: "my-ext", display: false }),
  entry("custom-nonstring-type", { type: "custom_message", customType: 42, display: true }),
  entry("custom-prototype-toString", {
    type: "custom_message",
    customType: "toString",
    display: true,
    details: { id: "child-9" },
  }),
  entry("custom-prototype-constructor", {
    type: "custom_message",
    customType: "constructor",
    display: true,
    details: { id: "child-9" },
  }),
  entry("subagent-notification", {
    type: "custom_message",
    customType: "subagent-notification",
    content: "<task-notification/>",
    display: true,
    details: {
      id: "child-1",
      description: "Check deployment",
      status: "error",
      error: "Unsupported model",
      resultPreview: "No output.",
      durationMs: 4200,
      outputFile: "/private/tasks/session.jsonl",
    },
  }),
  entry("subagent-update", {
    type: "custom_message",
    customType: "subagent-update",
    display: true,
    details: { id: "child-2", description: "Check services", message: "halfway there" },
  }),
  entry("subagent-workspace-notice", {
    type: "custom_message",
    customType: "subagent-workspace-notice",
    display: true,
    details: { id: "child-3", description: "Clean up", notice: "Changes retained." },
  }),
  entry("subagent-nonstring-details", {
    type: "custom_message",
    customType: "subagent-update",
    display: true,
    details: { id: "child-4", description: 42, status: null, durationMs: "soon" },
  }),
  entry("subagent-details-scalar", {
    type: "custom_message",
    customType: "subagent-notification",
    display: true,
    details: "child-5",
  }),
  entry("inbox-batch", {
    type: "custom_message",
    customType: "pi-orb.user-message",
    content: "two messages",
    details: { messageIds: ["message-1", 7, "message-2"], delivery: "turn" },
  }),
  entry("inbox-single", {
    type: "custom_message",
    customType: "pi-orb.user-message",
    content: "one message",
    details: { messageId: "message-3" },
  }),
  entry("inbox-none", {
    type: "custom_message",
    customType: "pi-orb.user-message",
    content: "typed in the terminal",
    details: {},
  }),
  entry("inbox-empty-batch", {
    type: "custom_message",
    customType: "pi-orb.user-message",
    content: "squashed nothing",
    details: { messageIds: [], messageId: "message-4" },
  }),
  entry("failure", {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket closed 1006",
      diagnostics: [{ type: "provider_transport_failure" }, "junk", { type: 7 }],
    },
  }),
  entry("failure-plain", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "usage limit reached" },
  }),
  entry("failure-null-diagnostics", {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "stream aborted",
      diagnostics: null,
    },
  }),
  entry("failure-object-diagnostics", {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "stream aborted",
      diagnostics: {},
    },
  }),
  entry("failure-nonstring-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: 1006 },
  }),
  entry("failure-blank-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "   " },
  }),
  entry("failure-ascii-whitespace-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "\t\n\v\f\r " },
  }),
  entry("failure-unicode-whitespace-message", {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
    },
  }),
  entry("failure-surrounded-message", {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "\t\u00a0actual failure\u3000\n\ufeff",
    },
  }),
  entry("failure-next-line-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "\u0085" },
  }),
  entry("failure-mongolian-vowel-separator-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "\u180e" },
  }),
  entry("failure-zero-width-space-message", {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage: "\u200b" },
  }),
  entry("tool-patch", {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "edit-1",
      content: "updated",
      details: { patch: "--- a\n+++ b\n+new" },
    },
  }),
  entry("tool-plain", {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "bash-1",
      content: "done",
      details: { exitCode: 0 },
    },
  }),
  entry("tool-nonstring-patch", {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "edit-2",
      content: "updated",
      details: { patch: 42 },
    },
  }),
  entry("message-empty-content-patch", {
    type: "message",
    message: { role: "user", content: [], details: { patch: "--- a\n+++ b\n+new" } },
  }),
  entry("custom-entry", {
    type: "custom",
    customType: "subagent-notification",
    data: { id: "child-6", status: "completed" },
  }),
];

const TYPED_FIELDS = ["shell", "custom", "subagent", "inboxMessageIds", "failure"] as const;

/** The same record as persisted before the adapter derived typed fields. */
function legacyForm(record: HistoryRecord): Record<string, unknown> {
  const legacy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  for (const field of TYPED_FIELDS) delete legacy[field];
  const content = legacy["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === "object") {
        delete (block as Record<string, unknown>)["patch"];
      }
    }
  }
  return legacy;
}

describe(`${BACKFILL} history backfill`, () => {
  const client = new PGliteClient();
  const mapped = new Map<string, HistoryRecord>();
  const stored = new Map<string, HistoryRecord>();

  beforeAll(async () => {
    expect((await runMigrations(client)).isOk()).toBe(true);
    expect(
      (
        await client.query(
          "INSERT INTO projects (id, name, repository_url) VALUES ($1, 'p', 'https://example.com/r.git')",
          [PROJECT],
        )
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await client.query(
          "INSERT INTO orbs (id, project_id, state, host_kind) VALUES ($1, $2, 'stopped', 'process')",
          [ORB, PROJECT],
        )
      ).isOk(),
    ).toBe(true);
    for (const native of entries) {
      const result = mapPiEntry(native);
      expect(result.isOk(), `mapping failed for ${String(native["id"])}`).toBe(true);
      if (!result.isOk()) continue;
      mapped.set(result.value.id, result.value);
      expect(
        (
          await client.query(
            "INSERT INTO history_records (orb_id, record_id, parent_id, record) VALUES ($1, $2, NULL, $3)",
            [ORB, result.value.id, jsonParam(legacyForm(result.value))],
          )
        ).isOk(),
      ).toBe(true);
    }
    // The legacy rows exist only now, so replay the backfill over them.
    expect(
      (await client.query("DELETE FROM schema_migrations WHERE name = $1", [BACKFILL])).isOk(),
    ).toBe(true);
    const replayed = await runMigrations(client);
    expect(replayed.isOk() ? replayed.value : replayed.error).toEqual([BACKFILL]);
    const rows = await client.query("SELECT record FROM history_records");
    expect(rows.isOk()).toBe(true);
    if (!rows.isOk()) return;
    for (const row of rows.value.rows) {
      const record = row["record"] as HistoryRecord;
      stored.set(record.id, record);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  it("backfills exactly what the Pi adapter derives", () => {
    expect(mapped.size).toBe(entries.length);
    for (const [id, record] of mapped) {
      expect(stored.get(id), `backfilled ${id}`).toEqual(record);
    }
  });

  it("matches ECMAScript trim boundaries for assistant failures", () => {
    for (const id of ["failure-ascii-whitespace-message", "failure-unicode-whitespace-message"]) {
      expect(mapped.get(id)).not.toHaveProperty("failure");
      expect(stored.get(id)).not.toHaveProperty("failure");
    }

    for (const id of [
      "failure-surrounded-message",
      "failure-next-line-message",
      "failure-mongolian-vowel-separator-message",
      "failure-zero-width-space-message",
    ]) {
      expect(mapped.get(id)).toHaveProperty("failure");
      expect(stored.get(id)).toHaveProperty("failure");
    }
  });

  it("keeps every backfilled record valid", () => {
    for (const id of mapped.keys()) {
      expect(Check(HistoryRecordSchema, stored.get(id)), `invalid record ${id}`).toBe(true);
    }
  });
});
