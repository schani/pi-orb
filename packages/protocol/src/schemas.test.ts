import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema,
  ControlPlaneHttpErrorSchema,
  HarnessSessionMetadataSchema,
  HistoryRecordSchema,
  OrbHistoryViewSchema,
  OrbViewSchema,
  ProjectViewSchema,
  PullHistoryResponseSchema,
  RequestResultFrameSchema,
  RuntimeEventFrameSchema,
  RuntimeHealthSchema,
  RuntimeHttpErrorSchema,
  ServerFrameSchema,
  ServerWelcomeSchema,
} from "./index.ts";

const messageRecord = {
  id: "rec-2",
  parentId: "rec-1",
  timestamp: "2026-07-20T10:00:00.000Z",
  overflow: { native: { type: "message", id: "rec-2" } },
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "hello" },
    { type: "reasoning", text: "thinking...", redacted: false },
    { type: "tool_call", callId: "c1", name: "bash", arguments: { cmd: "ls" } },
  ],
  model: { provider: "openai-codex", id: "gpt-5.2-codex" },
  usage: { inputTokens: 10, outputTokens: 20 },
  finishReason: "stop",
};

const compactionRecord = {
  id: "rec-3",
  parentId: "rec-2",
  timestamp: "2026-07-20T10:01:00.000Z",
  overflow: { native: {} },
  type: "compaction",
  summary: [{ type: "text", text: "summary" }],
};

const eventRecord = {
  id: "rec-4",
  parentId: null,
  timestamp: "2026-07-20T10:02:00.000Z",
  overflow: { native: {} },
  type: "event",
  eventType: "pi.model_change",
};

const sessionMetadata = {
  id: "session-1",
  timestamp: "2026-07-20T09:00:00.000Z",
  overflow: { native: { id: "session-1" } },
};

describe("history schemas", () => {
  it("accepts all record variants", () => {
    expect(Check(HistoryRecordSchema, messageRecord)).toBe(true);
    expect(Check(HistoryRecordSchema, compactionRecord)).toBe(true);
    expect(Check(HistoryRecordSchema, eventRecord)).toBe(true);
  });

  it("accepts tool_result blocks with nested content", () => {
    const record = {
      ...messageRecord,
      id: "rec-5",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "c1",
          content: [{ type: "text", text: "output" }],
          isError: false,
        },
      ],
    };
    expect(Check(HistoryRecordSchema, record)).toBe(true);
  });

  it("rejects records with unknown extra properties (closed schemas)", () => {
    expect(Check(HistoryRecordSchema, { ...messageRecord, extra: 1 })).toBe(false);
    expect(Check(HistoryRecordSchema, { ...eventRecord, sequence: 7 })).toBe(false);
  });

  it("rejects records missing required fields", () => {
    const { overflow: _overflow, ...withoutOverflow } = messageRecord;
    expect(Check(HistoryRecordSchema, withoutOverflow)).toBe(false);
    const { parentId: _parentId, ...withoutParent } = eventRecord;
    expect(Check(HistoryRecordSchema, withoutParent)).toBe(false);
  });

  it("accepts session metadata", () => {
    expect(Check(HarnessSessionMetadataSchema, sessionMetadata)).toBe(true);
    expect(Check(HarnessSessionMetadataSchema, { ...sessionMetadata, extra: true })).toBe(false);
  });
});

describe("runtime HTTP schemas", () => {
  it("accepts all health variants", () => {
    expect(
      Check(RuntimeHealthSchema, {
        v: 1,
        orbId: "orb-1",
        runtimeInstanceId: "run-1",
        status: "initializing",
        phase: "cloning",
      }),
    ).toBe(true);
    expect(
      Check(RuntimeHealthSchema, {
        v: 1,
        orbId: "orb-1",
        runtimeInstanceId: "run-1",
        status: "ready",
        sessionId: "session-1",
        checkoutCommit: "abc123",
        activity: "idle",
      }),
    ).toBe(true);
    expect(
      Check(RuntimeHealthSchema, {
        v: 1,
        orbId: "orb-1",
        runtimeInstanceId: "run-1",
        status: "failed",
        error: { code: "session_load_failed", message: "corrupt", retryable: false },
      }),
    ).toBe(true);
  });

  it("rejects a ready health without session identity", () => {
    expect(
      Check(RuntimeHealthSchema, {
        v: 1,
        orbId: "orb-1",
        runtimeInstanceId: "run-1",
        status: "ready",
        activity: "idle",
      }),
    ).toBe(false);
  });

  it("accepts pull history responses", () => {
    expect(
      Check(PullHistoryResponseSchema, {
        v: 1,
        orbId: "orb-1",
        runtimeInstanceId: "run-1",
        activity: "busy",
        session: sessionMetadata,
        records: [messageRecord],
        cursor: "rec-2",
        headId: "rec-2",
      }),
    ).toBe(true);
  });

  it("accepts runtime http errors", () => {
    expect(
      Check(RuntimeHttpErrorSchema, {
        v: 1,
        error: { code: "cursor_not_found", message: "unknown cursor", retryable: false },
      }),
    ).toBe(true);
  });
});

describe("frame schemas", () => {
  it("accepts client hello and requests", () => {
    expect(
      Check(ClientFrameSchema, {
        v: 1,
        type: "client.hello",
        clientInstanceId: "tab-1",
        afterRecordId: null,
      }),
    ).toBe(true);
    expect(
      Check(ClientFrameSchema, {
        v: 1,
        type: "client.request",
        requestId: "req-1",
        action: {
          type: "message",
          expectedHeadId: "rec-2",
          content: [{ type: "text", text: "do something" }],
        },
      }),
    ).toBe(true);
    expect(
      Check(ClientFrameSchema, {
        v: 1,
        type: "client.request",
        requestId: "req-2",
        action: { type: "abort", operationId: "op-1" },
      }),
    ).toBe(true);
  });

  it("rejects unknown client actions", () => {
    expect(
      Check(ClientFrameSchema, {
        v: 1,
        type: "client.request",
        requestId: "req-3",
        action: { type: "steer", text: "nope" },
      }),
    ).toBe(false);
  });

  it("accepts server frames", () => {
    expect(
      Check(ServerWelcomeSchema, {
        v: 1,
        type: "server.welcome",
        at: "2026-07-20T10:00:00.000Z",
        connectionId: "conn-1",
        runtimeInstanceId: "run-1",
        orbId: "orb-1",
        sessionId: "session-1",
        capabilities: ["abort", "input.image"],
        limits: { maxIncomingFrameBytes: 1048576, maxPromptBytes: 262144 },
      }),
    ).toBe(true);
    expect(
      Check(ServerFrameSchema, {
        v: 1,
        type: "sync.started",
        at: "2026-07-20T10:00:00.000Z",
        mode: "full",
        afterRecordId: null,
      }),
    ).toBe(true);
    expect(
      Check(ServerFrameSchema, {
        v: 1,
        type: "history.record",
        at: "2026-07-20T10:00:00.000Z",
        record: messageRecord,
        headId: "rec-2",
      }),
    ).toBe(true);
    expect(
      Check(ServerFrameSchema, {
        v: 1,
        type: "sync.completed",
        at: "2026-07-20T10:00:00.000Z",
        headId: "rec-2",
      }),
    ).toBe(true);
  });

  it("accepts runtime events", () => {
    expect(
      Check(RuntimeEventFrameSchema, {
        v: 1,
        type: "runtime.event",
        at: "2026-07-20T10:00:00.000Z",
        event: {
          type: "output_patch",
          operationId: "op-1",
          blockId: "b1",
          blockType: "text",
          revision: 3,
          patch: { type: "append", text: "more" },
        },
      }),
    ).toBe(true);
    expect(
      Check(RuntimeEventFrameSchema, {
        v: 1,
        type: "runtime.event",
        at: "2026-07-20T10:00:00.000Z",
        event: {
          type: "tool_state",
          operationId: "op-1",
          callId: "c1",
          name: "bash",
          revision: 1,
          state: "running",
        },
      }),
    ).toBe(true);
    expect(
      Check(RuntimeEventFrameSchema, {
        v: 1,
        type: "runtime.event",
        at: "2026-07-20T10:00:00.000Z",
        event: { type: "status", activity: "busy", operationId: "op-1" },
      }),
    ).toBe(true);
  });

  it("accepts request results", () => {
    expect(
      Check(RequestResultFrameSchema, {
        v: 1,
        type: "request.result",
        at: "2026-07-20T10:00:00.000Z",
        requestId: "req-1",
        result: { type: "accepted", operationId: "op-1", duplicate: false },
      }),
    ).toBe(true);
    expect(
      Check(RequestResultFrameSchema, {
        v: 1,
        type: "request.result",
        at: "2026-07-20T10:00:00.000Z",
        requestId: "req-1",
        result: {
          type: "rejected",
          error: { code: "stale_head", message: "head moved", retryable: false },
        },
      }),
    ).toBe(true);
  });
});

describe("control-plane API schemas", () => {
  it("accepts views", () => {
    expect(
      Check(ProjectViewSchema, {
        id: "p1",
        name: "demo",
        repositoryUrl: "https://github.com/owner/repo",
        createdAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Check(OrbViewSchema, {
        id: "o1",
        projectId: "p1",
        state: "stopping",
        stateVersion: 4,
        checkoutCommit: "abc123",
        stateDetail: { type: "draining_history", retrying: true, message: "db outage" },
        stateChangedAt: "2026-07-20T10:00:00.000Z",
        createdAt: "2026-07-20T09:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Check(OrbViewSchema, {
        id: "o1",
        projectId: "p1",
        state: "creating",
        stateVersion: 0,
        actionRequired: {
          type: "openai_codex_device_login",
          verificationUri: "https://auth.openai.com/device",
          userCode: "ABCD-1234",
          expiresAt: "2026-07-20T10:15:00.000Z",
        },
        stateChangedAt: "2026-07-20T10:00:00.000Z",
        createdAt: "2026-07-20T09:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Check(OrbHistoryViewSchema, {
        orbId: "o1",
        session: sessionMetadata,
        cursor: "rec-2",
        headId: "rec-2",
        records: [messageRecord, compactionRecord],
      }),
    ).toBe(true);
    expect(
      Check(ControlPlaneHttpErrorSchema, {
        error: { code: "conflict", message: "orb is stopping", retryable: true },
      }),
    ).toBe(true);
  });

  it("never allows OAuth credential fields to serialize (DESIGN §15.1)", () => {
    // Walk every browser-facing schema: every object must be closed and no
    // property may be named `access` or `refresh`.
    const browserSchemas = [
      ProjectViewSchema,
      OrbViewSchema,
      OrbHistoryViewSchema,
      ControlPlaneHttpErrorSchema,
      ServerFrameSchema,
    ];
    const forbidden = new Set(["access", "refresh"]);
    const visit = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          visit(item, `${path}[${i}]`);
        });
        return;
      }
      const obj = node as Record<string, unknown>;
      if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
        expect(obj.additionalProperties, `${path} must be a closed schema`).toBe(false);
        for (const key of Object.keys(obj.properties as Record<string, unknown>)) {
          expect(forbidden.has(key), `${path}.${key} must not exist`).toBe(false);
        }
      }
      for (const [key, value] of Object.entries(obj)) visit(value, `${path}.${key}`);
    };
    for (const schema of browserSchemas) visit(schema, "schema");
  });
});
