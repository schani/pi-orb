import { closeSync, fsyncSync, openSync, renameSync, watch, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(
  process.argv[2]
    ? `${process.argv[2]}/package.json`
    : new URL("../../package.json", import.meta.url),
);
const { err, ok, Result, ResultAsync } = require("neverthrow");

/** Await native consumed-input evidence, not merely model-request arrival. */
export function durableReceiptEdge(rootPath, statePath, messageId, onInspection = () => {}) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const inspect = async () => {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const expected = state.deliveries[messageId]?.uuid;
      const source = await readFile(rootPath, "utf8");
      if (!expected || !source.endsWith("\n")) return;
      const found = source
        .trim()
        .split("\n")
        .some((line) => {
          const row = JSON.parse(line);
          return row.uuid === expected && row.type === "user";
        });
      onInspection();
      if (found) resolve();
    } catch {
      reject(new Error("native_receipt_observation_failed"));
    }
  };
  // Arm before input admission; a local HTTP request is not durable evidence.
  const watcher = watch(dirname(rootPath), () => {
    void inspect();
  });
  watcher.on("error", () => reject(new Error("native_receipt_observation_failed")));
  return { promise, inspect, close: () => watcher.close() };
}

const knownFailures = new Set([
  "history_unavailable",
  "claude_auth_publication_failed",
  "claude_auth_required",
  "claude_child_guard_failed",
  "claude_child_recovery_required",
  "claude_cleanup_publication_failed",
  "claude_delivery_uncertain",
  "claude_handoff_guard_failed",
  "claude_initialization_failed",
  "claude_initialization_publication_failed",
  "claude_input_persistence_failed",
  "claude_mcp_cleanup_failed",
  "claude_mcp_publication_failed",
  "claude_metadata_publication_failed",
  "claude_metadata_uncertain",
  "claude_process_failed",
  "claude_recovery_persistence_failed",
  "claude_recovery_publication_failed",
  "claude_rotation_publication_failed",
  "claude_rotation_uncertain",
  "claude_sdk_unavailable",
  "claude_settings_failed",
  "claude_settings_persistence_failed",
  "claude_shutdown_failed",
  "claude_stdout_drain_failed",
  "claude_stop_fence_failed",
  "claude_stream_ended",
  "claude_stream_failed",
  "claude_stream_identity_gap",
  "claude_terminal_persistence_failed",
]);
const recordTypes = new Set([
  "user",
  "assistant",
  "system",
  "message",
  "event",
  "tool_call",
  "tool_result",
  "stream_event",
  "progress",
  "summary",
  "file-history-snapshot",
]);
const blockTypes = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);
const aliases = new Map();
function safeId(value) {
  if (typeof value !== "string") return null;
  if (value.length > 256) return "fixture-id-overflow";
  if (/^fixture-id-(?:[0-9]+|overflow)$/.test(value)) return value;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) return value;
  if (!aliases.has(value)) {
    if (aliases.size >= 512) return "fixture-id-overflow";
    aliases.set(value, `fixture-id-${aliases.size + 1}`);
  }
  return aliases.get(value);
}
function safeRow(row, stream = false) {
  return {
    type: recordTypes.has(row?.type) ? row.type : "unknown",
    uuid: safeId(row?.uuid ?? row?.id),
    parentUuid: safeId(
      row?.parentUuid ?? row?.parentUUID ?? row?.parent_uuid ?? row?.parent_tool_use_id,
    ),
    sessionId: safeId(row?.sessionId ?? row?.session_id),
    ...(stream
      ? {
          sdkMessageId: safeId(row?.message?.id ?? row?.event?.message?.id ?? row?.sdkMessageId),
          taskId: safeId(row?.task_id ?? row?.taskId),
          childId: safeId(row?.agent_id ?? row?.childId),
          eventType: [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
          ].includes(row?.event?.type ?? row?.eventType)
            ? (row.event?.type ?? row.eventType)
            : null,
          blockIndex:
            Number.isSafeInteger(row?.event?.index ?? row?.blockIndex) &&
            (row?.event?.index ?? row?.blockIndex) >= 0 &&
            (row?.event?.index ?? row?.blockIndex) < 64
              ? (row?.event?.index ?? row?.blockIndex)
              : null,
        }
      : {}),
  };
}
export function safeQualificationEvidence(input) {
  const status = ["ready", "failed", "initializing"].includes(input.health?.status)
    ? input.health.status
    : "unknown";
  return {
    health: {
      status,
      code:
        status === "failed"
          ? knownFailures.has(input.health?.error?.code)
            ? input.health.error.code
            : "runtime_failure"
          : null,
    },
    operationErrorCode:
      status === "failed"
        ? knownFailures.has(input.health?.error?.code)
          ? input.health.error.code
          : "runtime_failure"
        : input.operationFailure === true
          ? "sdk_result_failed"
          : null,
    nativeSupervision: Object.fromEntries(
      [
        "spawned",
        "closed",
        "active",
        "exitEdges",
        "stdoutEOF",
        "publicStreamEOF",
        "hooksStarted",
        "hooksEnded",
        "hooksFailed",
      ].map((name) => [
        name,
        Number.isSafeInteger(input.nativeSupervision?.[name]) &&
        input.nativeSupervision[name] >= 0 &&
        input.nativeSupervision[name] <= 65536
          ? input.nativeSupervision[name]
          : null,
      ]),
    ),
    sessionId: safeId(input.snapshot?.session?.id),
    records: (input.snapshot?.records ?? []).slice(-128).map((row) => safeRow(row)),
    nativeRows: (input.nativeRows ?? []).slice(-128).map((row) => safeRow(row)),
    streamRows: (input.streamRows ?? []).slice(-128).map((row) => safeRow(row, true)),
    pendingBlocks: (input.pendingBlocks ?? []).slice(-64).map((block) => ({
      index:
        Number.isSafeInteger(block.index) && block.index >= 0 && block.index < 64
          ? block.index
          : null,
      type: blockTypes.has(block.type) ? block.type : "unknown",
    })),
  };
}

/** Tail only owned native rows; neither payload nor filenames leave this boundary. */
export function nativeQualificationRows(path) {
  return ResultAsync.fromThrowable(
    async () => {
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        const offset = Math.max(0, stat.size - 256 * 1024);
        const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        const source = buffer.subarray(0, bytesRead).toString("utf8");
        const lines = source.split("\n");
        if (offset > 0) lines.shift();
        if (!source.endsWith("\n")) lines.pop();
        return lines
          .filter(Boolean)
          .slice(-128)
          .map((line) => safeRow(JSON.parse(line)));
      } finally {
        await file.close();
      }
    },
    () => ({ code: "qualification_native_trace_unavailable" }),
  )();
}

/** Atomic, fsynced last checkpoint survives namespace SIGKILL and outer cleanup. */
export function persistQualificationTrace(path, trace) {
  return Result.fromThrowable(
    () => {
      const source = JSON.stringify(trace);
      if (Buffer.byteLength(source) > 192 * 1024) return false;
      const next = `${path}.next`;
      const file = openSync(next, "w", 0o600);
      try {
        writeFileSync(file, source);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(next, path);
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return true;
    },
    () => ({ code: "qualification_trace_write_failed" }),
  )().andThen((written) =>
    written ? ok(undefined) : err({ code: "qualification_trace_size_exceeded" }),
  );
}
