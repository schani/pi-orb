/**
 * Interrupted-turn resume at runtime boot (docs/lifecycle.md).
 *
 * A host restart kills an in-flight agent turn: the runtime's `activity` flag
 * is in-memory, so on the next boot the SDK restores the session's messages
 * and the runtime would sit idle forever. The interruption's evidence survives
 * in the persisted session tail, so the decision is made here — locally, at
 * boot, from the tail alone, never from the cause of the restart.
 *
 * Detection is pure; boot-notification.ts plans the visible record and turn.
 */

/** Custom type of the resume marker; also the guard key on the next boot. */
export const TURN_RESUME_CUSTOM_TYPE = "pi-orb.turn-resume";

/** Custom type of the record announcing a resume the loop guard declined. */
export const TURN_RESUME_DECLINED_CUSTOM_TYPE = "pi-orb.turn-resume-declined";

/** Addressed to the user: nothing will happen without them. */
export const TURN_RESUME_DECLINED_CONTENT =
  "The previous turn was interrupted again after three automatic attempts, so it will not be resumed automatically. Send a message to continue.";

export type InterruptedTurnShape =
  /** A tool result landed, but the assistant never spoke again. */
  | "trailing_tool_result"
  /** The assistant asked for tools; no result was ever recorded. */
  | "dangling_tool_calls"
  /** A user message or boot marker with no assistant reply (lost first bytes). */
  | "unanswered_user_message";

/** The interrupted tail a decision is about: its shape and its head entry. */
export interface InterruptedTail {
  readonly shape: InterruptedTurnShape;
  /** ID of the dangling tail entry, or null when the entry carries none. */
  readonly headRecordId: string | null;
}

/** What the loop guard is holding back on a `already_resumed` boot. */
export interface SuppressedResume extends InterruptedTail {
  /** A decline record already announced this suppression to the user. */
  readonly announced: boolean;
}

export type TurnResumeDecision =
  | ({ readonly resume: true } & InterruptedTail)
  | { readonly resume: false; readonly reason: "empty_session" | "settled_tail" }
  | {
      readonly resume: false;
      readonly reason: "already_resumed";
      /**
       * The interruption the guard is suppressing, or null when the tail
       * settled after the earlier resume — then the marker is merely an old
       * record in a healthy session, not a guard doing anything.
       */
      readonly suppressed: SuppressedResume | null;
    };

type TailEntry =
  | { readonly kind: "user"; readonly id: string | null }
  | {
      readonly kind: "assistant";
      readonly id: string | null;
      readonly stopReason: string | null;
      readonly hasToolCall: boolean;
    }
  | { readonly kind: "tool_result"; readonly id: string | null }
  | { readonly kind: "resume_marker"; readonly id: string | null }
  | { readonly kind: "boot_marker"; readonly id: string | null }
  | { readonly kind: "decline_marker"; readonly id: string | null }
  /** Conversational but not a turn boundary we resume from (compaction, …). */
  | { readonly kind: "other"; readonly id: string | null };

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classify(entry: unknown): TailEntry | null {
  if (!isRecordObject(entry)) return { kind: "other", id: null };
  const rawId = entry["id"];
  const id = typeof rawId === "string" ? rawId : null;
  switch (entry["type"]) {
    case "message": {
      const message = entry["message"];
      if (!isRecordObject(message)) return { kind: "other", id };
      switch (message["role"]) {
        case "user":
          return { kind: "user", id };
        case "assistant": {
          const content = message["content"];
          const hasToolCall =
            Array.isArray(content) &&
            content.some((block) => isRecordObject(block) && block["type"] === "toolCall");
          const stopReason = message["stopReason"];
          return {
            kind: "assistant",
            id,
            stopReason: typeof stopReason === "string" ? stopReason : null,
            hasToolCall,
          };
        }
        case "toolResult":
          return { kind: "tool_result", id };
        default:
          return { kind: "other", id };
      }
    }
    case "custom_message":
      switch (entry["customType"]) {
        case "pi-orb.user-message":
          return { kind: "user", id };
        case "pi-orb.system-message":
          return null;
        case "pi-orb.host-restarted": {
          const details = entry["details"];
          return isRecordObject(details) && typeof details["operationId"] === "string"
            ? { kind: "boot_marker", id }
            : null;
        }
        case "pi-orb.sleep-wake":
          return { kind: "boot_marker", id };
        case TURN_RESUME_CUSTOM_TYPE:
          return { kind: "resume_marker", id };
        case "pi-orb.restart-notification-failed":
        case TURN_RESUME_DECLINED_CUSTOM_TYPE:
          return { kind: "decline_marker", id };
        default:
          return { kind: "other", id };
      }
    case "thinking_level_change":
    case "model_change":
    case "label":
    case "session_info":
    case "custom":
      return null;
    default:
      return { kind: "other", id };
  }
}

/**
 * Whether the assistant message stopped mid-turn holding tool calls. Only
 * `toolUse` counts: `aborted` and `error` are turns that ended visibly and on
 * disk, and resuming an aborted turn would undo the one escape hatch a
 * runaway turn has.
 */
function stoppedOnToolUse(entry: TailEntry): boolean {
  return entry.kind === "assistant" && entry.stopReason === "toolUse" && entry.hasToolCall;
}

/**
 * The interrupted shape of a conversational tail, or null when it is settled.
 * Both markers are filtered out before this runs: they are pi-orb bookkeeping,
 * and neither the resume record nor the decline record may make a dangling
 * tail look finished — the guard's verdict must be the same on every boot.
 */
function interruptedTail(tail: readonly TailEntry[]): InterruptedTail | null {
  const last = tail[tail.length - 1];
  if (last === undefined) return null;

  if (last.kind === "tool_result") {
    // Walk back over the results of one multi-call assistant message.
    let index = tail.length - 1;
    while (index >= 0 && tail[index]?.kind === "tool_result") index--;
    const parent = index >= 0 ? tail[index] : undefined;
    if (parent !== undefined && stoppedOnToolUse(parent)) {
      return { shape: "trailing_tool_result", headRecordId: last.id };
    }
    return null;
  }
  if (stoppedOnToolUse(last)) return { shape: "dangling_tool_calls", headRecordId: last.id };
  if (last.kind === "user" || last.kind === "boot_marker")
    return { shape: "unanswered_user_message", headRecordId: last.id };
  return null;
}

/**
 * Decide, from the session's full entries root→leaf (not compacted model
 * context), whether a turn was interrupted and has fewer than three
 * turn-triggering boot records after the last real user.
 */
export function detectInterruptedTurn(entries: readonly unknown[]): TurnResumeDecision {
  const tail: TailEntry[] = [];
  for (const entry of entries) {
    const classified = classify(entry);
    if (classified !== null) tail.push(classified);
  }
  if (tail.length === 0) return { resume: false, reason: "empty_session" };

  const conversational = tail.filter(
    (entry) => entry.kind !== "resume_marker" && entry.kind !== "decline_marker",
  );

  // Every triggering boot record claims one attempt before inference starts.
  // Count the full session, not compacted model context or a settled suffix.
  const lastUserIndex = tail.findLastIndex((entry) => entry.kind === "user");
  const claims = tail
    .slice(lastUserIndex + 1)
    .filter((entry) => entry.kind === "resume_marker" || entry.kind === "boot_marker").length;
  const dangling = interruptedTail(conversational);
  if (claims > 0 && dangling === null)
    return { resume: false, reason: "already_resumed", suppressed: null };
  if (dangling === null) return { resume: false, reason: "settled_tail" };
  if (claims < 3) return { resume: true, ...dangling };
  const declineIndex = tail.findLastIndex((entry) => entry.kind === "decline_marker");
  return {
    resume: false,
    reason: "already_resumed",
    suppressed: { ...dangling, announced: declineIndex > lastUserIndex },
  };
}
