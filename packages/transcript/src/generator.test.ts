import { mkdirSync, writeFileSync } from "node:fs";
import type { HistoryRecord, OrbHistoryView, ServerFrame } from "@pi-orb/protocol";
import { type EntropySource, sample } from "determined";
import { expect, it } from "vitest";
import { serializeState } from "./serialize.ts";
import {
  initialState,
  type LiveConnectionStatus,
  reducer,
  type TranscriptAction,
} from "./state.ts";
import { SeededEntropySource } from "./testkit/entropy.ts";

/** Seeds replayed on every run; the first `COMMITTED_SEEDS` are also a fixture. */
const SEEDS = 40;
const COMMITTED_SEEDS = 5;
const STEPS = 30;
const AT = "2026-09-16T00:00:00Z";

const CONNECTION: [LiveConnectionStatus, ...LiveConnectionStatus[]] = [
  "open",
  "connecting",
  "retrying",
  "closed",
];

function pick<T>(entropy: EntropySource, reason: string, items: readonly [T, ...T[]]): T {
  return sample(entropy, reason, items) ?? items[0];
}

interface Context {
  /** Record ids in the order the generator first emitted them. */
  records: string[];
  blocks: string[];
  operationId: string;
  requestId: string | null;
  seq: number;
}

function record(id: string, parentId: string | null): HistoryRecord {
  return {
    id,
    parentId,
    timestamp: AT,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: `text for ${id}` }],
    overflow: {},
  };
}

function view(ids: readonly string[]): OrbHistoryView {
  return {
    orbId: "orb-1",
    session: { id: "s1", overflow: {} },
    records: ids.map((id, index) => record(id, ids[index - 1] ?? null)),
    cursor: ids[ids.length - 1] ?? null,
    headId: ids[ids.length - 1] ?? null,
  };
}

const frame = (f: ServerFrame): TranscriptAction => ({ type: "frame", frame: f });

type RequestResult = Extract<ServerFrame, { type: "request.result" }>["result"];

const KINDS = [
  "connection",
  "welcome",
  "sync_started",
  "record",
  "sync_completed",
  "patch",
  "tool",
  "operation_started",
  "status",
  "subagents",
  "operation_finished",
  "request_sent",
  "request_result",
  "composer",
  "history_loaded",
  "history_refreshed",
] as const;

function nextAction(entropy: EntropySource, context: Context): TranscriptAction {
  const kind = pick(entropy, "action kind", KINDS);
  const lastRecord = context.records[context.records.length - 1] ?? null;
  switch (kind) {
    case "connection":
      return {
        type: "connection_status",
        status: pick(entropy, "connection status", CONNECTION),
      };
    case "welcome":
      return frame({
        v: 1,
        at: AT,
        type: "server.welcome",
        connectionId: `c${context.seq}`,
        runtimeInstanceId: `ri${context.seq}`,
        orbId: "orb-1",
        sessionId: pick(entropy, "session", ["s1", "s2"]),
        capabilities: ["abort"],
        limits: { maxIncomingFrameBytes: 1000000, maxPromptBytes: 6000 },
      });
    case "sync_started":
      return frame({
        v: 1,
        at: AT,
        type: "sync.started",
        mode: pick(entropy, "sync mode", ["full", "after"]),
        afterRecordId: lastRecord,
      });
    case "record": {
      const reuse = context.records.length > 0 && entropy.random("reuse record") < 0.3;
      const id = reuse
        ? pick(entropy, "record id", context.records as [string, ...string[]])
        : `r${context.seq}`;
      if (!context.records.includes(id)) context.records.push(id);
      const retired =
        context.blocks.length > 0 && entropy.random("retire block") < 0.4
          ? [pick(entropy, "retired block", context.blocks as [string, ...string[]])]
          : [];
      return frame({
        v: 1,
        at: AT,
        type: "history.record",
        record: record(id, lastRecord),
        retiredBlockIds: retired,
        headId: entropy.random("head") < 0.5 ? id : null,
      });
    }
    case "sync_completed":
      return frame({ v: 1, at: AT, type: "sync.completed", headId: lastRecord });
    case "patch": {
      const reuse = context.blocks.length > 0 && entropy.random("reuse block") < 0.5;
      const blockId = reuse
        ? pick(entropy, "block id", context.blocks as [string, ...string[]])
        : `b${context.seq}`;
      if (!context.blocks.includes(blockId)) context.blocks.push(blockId);
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: {
          type: "output_patch",
          operationId: context.operationId,
          blockId,
          blockType: pick(entropy, "block type", ["text", "reasoning", "shell"]),
          revision: context.seq,
          patch: {
            type: pick(entropy, "patch type", ["append", "replace"]),
            text: `chunk ${context.seq}`,
          },
        },
      });
    }
    case "tool":
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: {
          type: "tool_state",
          operationId: context.operationId,
          callId: pick(entropy, "call id", ["call-1", "call-2"]),
          name: pick(entropy, "tool name", ["bash", "read", "edit"]),
          revision: context.seq,
          state: pick(entropy, "call state", ["running", "completed", "failed"]),
        },
      });
    case "operation_started":
      context.operationId = `op${context.seq}`;
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: { type: "operation_started", operationId: context.operationId },
      });
    case "status":
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: {
          type: "status",
          activity: pick(entropy, "activity", ["busy", "idle"]),
          ...(entropy.random("status operation") < 0.5 ? { operationId: context.operationId } : {}),
        },
      });
    case "subagents":
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: {
          type: "subagents",
          operationId: pick(entropy, "roster operation", [context.operationId, "op-stale"]),
          children: [{ id: "child", description: "Work", phase: "running" }],
        },
      });
    case "operation_finished":
      return frame({
        v: 1,
        at: AT,
        type: "runtime.event",
        event: {
          type: "operation_finished",
          operationId: context.operationId,
          outcome: pick(entropy, "outcome", ["completed", "aborted", "failed"]),
        },
      });
    case "request_sent":
      context.requestId = `req${context.seq}`;
      return {
        type: "request_sent",
        requestId: context.requestId,
        kind: pick(entropy, "request kind", ["message", "shell", "abort", "settings"]),
      };
    case "request_result": {
      const results: [RequestResult, ...RequestResult[]] = [
        { type: "accepted", operationId: context.operationId, duplicate: false },
        { type: "settings_applied", duplicate: false },
        { type: "rejected", error: { code: "busy", message: "runtime busy", retryable: true } },
      ];
      return frame({
        v: 1,
        at: AT,
        type: "request.result",
        requestId: context.requestId ?? "unknown",
        result: pick(entropy, "result", results),
      });
    }
    case "composer":
      return {
        type: "composer_changed",
        text: `draft ${context.seq}`,
        mode: pick(entropy, "composer mode", ["message", "shell", "command"]),
      };
    case "history_loaded":
      return { type: "history_loaded", view: view(context.records) };
    case "history_refreshed":
      return {
        type: "history_refreshed",
        view: view(context.records.slice(0, Math.max(0, context.records.length - 1))),
        epoch: Math.floor(entropy.random("epoch") * 4),
      };
  }
}

interface Step {
  action: TranscriptAction;
}

function generate(seed: number): { name: string; steps: Step[] } {
  const entropy = new SeededEntropySource(seed);
  const context: Context = { records: [], blocks: [], operationId: "op0", requestId: null, seq: 0 };
  const steps: Step[] = [];
  for (let index = 0; index < STEPS; index++) {
    context.seq = index + 1;
    steps.push({ action: nextAction(entropy, context) });
  }
  return { name: `generated seed ${seed}`, steps };
}

it.each(Array.from({ length: SEEDS }, (_, index) => index + 1))(
  "generated seed %i keeps the model's invariants",
  (seed) => {
    const { name, steps } = generate(seed);
    let state = initialState();
    let arrivals: string[] = [];
    for (const [index, step] of steps.entries()) {
      const before = state;
      state = reducer(state, step.action);
      const where = `${name} step ${index} (${step.action.type})`;

      // Records are keyed by their own id. Live frames append in arrival
      // order; a replica read is authoritative and re-seeds that order.
      if (state.records.size === 0) arrivals = [];
      if (step.action.type.startsWith("history_")) arrivals = [...state.records.keys()];
      for (const [id, value] of state.records) {
        expect(id, where).toBe(value.id);
        if (!arrivals.includes(id)) arrivals.push(id);
      }
      expect([...state.records.keys()], `${where}: arrival order`).toEqual(
        arrivals.filter((id) => state.records.has(id)),
      );

      // A connection transition never drops the transcript.
      if (step.action.type === "connection_status") {
        expect(state.records, `${where}: records survive`).toBe(before.records);
      }

      // A finished operation leaves no transient live state behind.
      if (
        step.action.type === "frame" &&
        step.action.frame.type === "runtime.event" &&
        step.action.frame.event.type === "operation_finished"
      ) {
        expect(
          {
            blocks: state.liveBlocks.size,
            tools: state.tools.size,
            operationId: state.operationId,
            activity: state.activity,
            subagents: state.subagents.length,
          },
          `${where}: transient cleared`,
        ).toEqual({ blocks: 0, tools: 0, operationId: null, activity: "idle", subagents: 0 });
      }

      // Re-delivering a record frame changes nothing.
      if (step.action.type === "frame" && step.action.frame.type === "history.record") {
        expect(serializeState(reducer(state, step.action)), `${where}: upsert idempotence`).toEqual(
          serializeState(state),
        );
      }
    }

    if (seed <= COMMITTED_SEEDS && process.env["TRANSCRIPT_FIXTURES_WRITE"] === "1") {
      const directory = new URL("../fixtures/generated/", import.meta.url);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        new URL(`seed-${String(seed).padStart(2, "0")}.json`, directory),
        `${JSON.stringify({ name, steps, expect: serializeState(state) }, null, 2)}\n`,
      );
    }
  },
);
