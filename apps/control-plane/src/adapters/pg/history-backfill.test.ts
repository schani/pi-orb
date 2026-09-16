import { type HistoryRecord, HistoryRecordSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonParam } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { PGliteClient } from "./pglite-client.ts";

/**
 * Clients read typed record fields, so transcripts persisted before those
 * fields existed must gain them from the native blob they were mapped from
 * (docs/pi-adapter.md).
 */
const BACKFILL = "022_typed_history_fields.sql";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORB = "22222222-2222-4222-8222-222222222222";

const legacy = (id: string, record: Record<string, unknown>): Record<string, unknown> => ({
  id,
  parentId: null,
  timestamp: "2026-07-20T10:00:00.000Z",
  ...record,
});

const records: Record<string, unknown>[] = [
  legacy("shell", {
    type: "event",
    eventType: "pi.bash_execution",
    content: [{ type: "text", text: "npm test\npassing" }],
    overflow: {
      native: {
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
      },
    },
  }),
  legacy("shell-cancelled", {
    type: "event",
    eventType: "pi.bash_execution",
    content: [],
    overflow: {
      native: { type: "message", message: { role: "bashExecution", command: "sleep 10" } },
    },
  }),
  legacy("custom-shown", {
    type: "event",
    eventType: "pi.custom_message",
    content: [{ type: "text", text: "note" }],
    overflow: { native: { type: "custom_message", customType: "my-ext", display: true } },
  }),
  legacy("custom-hidden", {
    type: "event",
    eventType: "pi.custom_message",
    content: [],
    overflow: { native: { type: "custom_message", customType: "my-ext", display: false } },
  }),
  legacy("subagent-notification", {
    type: "event",
    eventType: "pi.custom_message",
    content: [{ type: "text", text: "<task-notification/>" }],
    overflow: {
      native: {
        type: "custom_message",
        customType: "subagent-notification",
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
      },
    },
  }),
  legacy("subagent-update", {
    type: "event",
    eventType: "pi.custom_message",
    content: [],
    overflow: {
      native: {
        type: "custom_message",
        customType: "subagent-update",
        display: true,
        details: { id: "child-2", description: "Check services", message: "halfway there" },
      },
    },
  }),
  legacy("subagent-workspace-notice", {
    type: "event",
    eventType: "pi.custom_message",
    content: [],
    overflow: {
      native: {
        type: "custom_message",
        customType: "subagent-workspace-notice",
        display: true,
        details: { id: "child-3", description: "Clean up", notice: "Changes retained." },
      },
    },
  }),
  legacy("inbox-batch", {
    type: "message",
    role: "user",
    content: [{ type: "text", text: "two messages" }],
    overflow: {
      native: {
        type: "custom_message",
        customType: "pi-orb.user-message",
        details: { messageIds: ["message-1", "message-2"], delivery: "turn" },
      },
    },
  }),
  legacy("inbox-single", {
    type: "message",
    role: "user",
    content: [{ type: "text", text: "one message" }],
    overflow: {
      native: {
        type: "custom_message",
        customType: "pi-orb.user-message",
        details: { messageId: "message-3" },
      },
    },
  }),
  legacy("failure", {
    type: "message",
    role: "assistant",
    content: [],
    finishReason: "error",
    overflow: {
      native: {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket closed 1006",
          diagnostics: [{ type: "provider_transport_failure" }, { type: "stream_aborted" }],
        },
      },
    },
  }),
  legacy("failure-plain", {
    type: "message",
    role: "assistant",
    content: [],
    finishReason: "error",
    overflow: {
      native: {
        type: "message",
        message: { role: "assistant", stopReason: "error", errorMessage: "usage limit reached" },
      },
    },
  }),
  legacy("tool-patch", {
    type: "message",
    role: "tool",
    content: [
      { type: "tool_result", callId: "edit-1", content: [{ type: "text", text: "updated" }] },
    ],
    overflow: {
      native: {
        type: "message",
        message: { role: "toolResult", details: { patch: "--- a\n+++ b\n+new" } },
      },
    },
  }),
  legacy("tool-plain", {
    type: "message",
    role: "tool",
    content: [{ type: "tool_result", callId: "bash-1", content: [{ type: "text", text: "done" }] }],
    overflow: {
      native: { type: "message", message: { role: "toolResult", details: { exitCode: 0 } } },
    },
  }),
];

describe(`${BACKFILL} history backfill`, () => {
  const client = new PGliteClient();
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
    for (const record of records) {
      expect(
        (
          await client.query(
            "INSERT INTO history_records (orb_id, record_id, parent_id, record) VALUES ($1, $2, NULL, $3)",
            [ORB, record["id"], jsonParam(record)],
          )
        ).isOk(),
      ).toBe(true);
    }
    // The legacy rows exist only now, so replay the backfill over them.
    expect(
      (await client.query("DELETE FROM schema_migrations WHERE name = $1", [BACKFILL])).isOk(),
    ).toBe(true);
    const replayed = await runMigrations(client);
    expect(replayed.isOk() && replayed.value).toEqual([BACKFILL]);
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

  const event = (id: string) => {
    const record = stored.get(id);
    if (record?.type !== "event") throw new Error(`missing event ${id}`);
    return record;
  };
  const messageRecord = (id: string) => {
    const record = stored.get(id);
    if (record?.type !== "message") throw new Error(`missing message ${id}`);
    return record;
  };

  it("keeps every backfilled record valid and its native overflow intact", () => {
    for (const original of records) {
      const record = stored.get(String(original["id"]));
      expect(Check(HistoryRecordSchema, record), `invalid record ${String(original["id"])}`).toBe(
        true,
      );
      expect(record?.overflow).toEqual(original["overflow"]);
    }
  });

  it("backfills shell blocks", () => {
    expect(event("shell").shell).toEqual({
      command: "npm test",
      output: "passing",
      exitCode: 2,
      cancelled: false,
      truncated: true,
      excludeFromContext: true,
    });
    expect(event("shell-cancelled").shell).toEqual({
      command: "sleep 10",
      output: "",
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    });
  });

  it("backfills custom-message visibility", () => {
    expect(event("custom-shown").custom).toEqual({ customType: "my-ext", display: true });
    expect(event("custom-hidden").custom).toEqual({ customType: "my-ext", display: false });
    expect(event("custom-shown").subagent).toBeUndefined();
  });

  it("backfills subagent receipts", () => {
    expect(event("subagent-notification").subagent).toEqual({
      kind: "notification",
      id: "child-1",
      description: "Check deployment",
      status: "error",
      error: "Unsupported model",
      resultPreview: "No output.",
      durationMs: 4200,
    });
    expect(event("subagent-update").subagent).toEqual({
      kind: "update",
      id: "child-2",
      description: "Check services",
      message: "halfway there",
    });
    expect(event("subagent-workspace-notice").subagent).toEqual({
      kind: "workspace_notice",
      id: "child-3",
      description: "Clean up",
      notice: "Changes retained.",
    });
  });

  it("backfills inbox identities from batched and single-id envelopes", () => {
    expect(messageRecord("inbox-batch").inboxMessageIds).toEqual(["message-1", "message-2"]);
    expect(messageRecord("inbox-single").inboxMessageIds).toEqual(["message-3"]);
  });

  it("backfills assistant failures with their diagnostic types", () => {
    expect(messageRecord("failure").failure).toEqual({
      message: "WebSocket closed 1006",
      diagnostics: ["provider_transport_failure", "stream_aborted"],
    });
    expect(messageRecord("failure-plain").failure).toEqual({
      message: "usage limit reached",
      diagnostics: [],
    });
  });

  it("backfills tool-result patches", () => {
    const patched = messageRecord("tool-patch").content[0];
    if (patched?.type !== "tool_result") throw new Error("expected tool_result");
    expect(patched.patch).toBe("--- a\n+++ b\n+new");
    const plain = messageRecord("tool-plain").content[0];
    if (plain?.type !== "tool_result") throw new Error("expected tool_result");
    expect(plain.patch).toBeUndefined();
  });
});
