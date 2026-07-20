import type { RuntimeEvent, ServerFrame } from "@pi-orb/protocol";
import type { HarnessSnapshot, LiveOperationView } from "./types.ts";

/**
 * Compute the §6.2 synchronization batch: sync.started, replayed complete
 * records after the client's cursor, reconstructing runtime events for the
 * live operation, sync.completed. Called synchronously from the hello handler
 * so no Pi callback can interleave; the caller enqueues the result on the
 * connection's ordered outbound writer.
 */
export function computeSyncFrames(
  snapshot: HarnessSnapshot,
  live: LiveOperationView | null,
  afterRecordId: string | null,
  at: string,
): ServerFrame[] {
  const frames: ServerFrame[] = [];
  let startIndex = 0;
  let mode: "full" | "after" = "full";
  let effectiveAfter: string | null = null;
  if (afterRecordId !== null) {
    const index = snapshot.records.findIndex((record) => record.id === afterRecordId);
    if (index !== -1) {
      mode = "after";
      effectiveAfter = afterRecordId;
      startIndex = index + 1;
    }
    // Unknown cursor: full replay; the UI upserts replayed records by ID.
  }
  frames.push({ v: 1, type: "sync.started", at, mode, afterRecordId: effectiveAfter });

  let representedHead: string | null = mode === "after" ? effectiveAfter : null;
  for (const record of snapshot.records.slice(startIndex)) {
    representedHead = record.id;
    frames.push({ v: 1, type: "history.record", at, record, headId: representedHead });
  }
  if (snapshot.headId !== null && startIndex >= snapshot.records.length) {
    // Caught-up reconnect: the client cursor already represents the head.
    representedHead = snapshot.headId;
  }

  const events: RuntimeEvent[] = [];
  if (live !== null) {
    events.push({ type: "operation_started", operationId: live.operationId });
    for (const block of live.blocks) {
      events.push({
        type: "output_patch",
        operationId: live.operationId,
        blockId: block.blockId,
        blockType: block.blockType,
        revision: block.revision,
        patch: { type: "replace", text: block.text },
      });
    }
    for (const tool of live.tools) {
      events.push({
        type: "tool_state",
        operationId: live.operationId,
        callId: tool.callId,
        name: tool.name,
        revision: tool.revision,
        state: tool.state,
        ...(tool.message !== undefined ? { message: tool.message } : {}),
      });
    }
    events.push({ type: "status", activity: snapshot.activity, operationId: live.operationId });
  } else {
    events.push({ type: "status", activity: snapshot.activity });
  }
  for (const event of events) {
    frames.push({ v: 1, type: "runtime.event", at, event });
  }

  frames.push({ v: 1, type: "sync.completed", at, headId: representedHead });
  return frames;
}
