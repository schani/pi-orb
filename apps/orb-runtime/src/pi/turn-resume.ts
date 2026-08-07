import type { RuntimeTurnResume } from "@pi-orb/protocol";
import { ResultAsync } from "neverthrow";

/**
 * Interrupted-turn resume at runtime boot (docs/lifecycle.md).
 *
 * A host restart kills an in-flight agent turn: the runtime's `activity` flag
 * is in-memory, so on the next boot the SDK restores the session's messages
 * and the runtime would sit idle forever. The interruption's evidence survives
 * in the persisted session tail, so the decision is made here — locally, at
 * boot, from the tail alone, never from the cause of the restart.
 *
 * Detection is a pure function of the session entries; issuing the resume is
 * a single `sendCustomMessage` whose entry is simultaneously the visible
 * marker, the turn trigger, and the durable once-per-interruption guard. When
 * that guard suppresses a resume it says so in history too: a declined resume
 * must be as visible as a performed one, or the guard reproduces the very
 * symptom it exists to prevent ("the orb silently stopped mid-work").
 */

/** Custom type of the resume marker; also the guard key on the next boot. */
export const TURN_RESUME_CUSTOM_TYPE = "pi-orb.turn-resume";

/** Custom type of the record announcing a resume the loop guard declined. */
export const TURN_RESUME_DECLINED_CUSTOM_TYPE = "pi-orb.turn-resume-declined";

/** Marker text. The model sees it: it is a session record, not an event. */
export const TURN_RESUME_CONTENT =
  "The previous turn was interrupted by a host restart — resuming it now. Continue from where you left off.";

/** Decline text. Addressed to the user: nothing will happen without them. */
export const TURN_RESUME_DECLINED_CONTENT =
  "The previous turn was interrupted again after it had already been resumed once, so it will not be resumed automatically a second time. Send a message to continue.";

export type InterruptedTurnShape =
  /** A tool result landed, but the assistant never spoke again. */
  | "trailing_tool_result"
  /** The assistant asked for tools; no result was ever recorded. */
  | "dangling_tool_calls"
  /** A user message with no assistant reply at all (lost first bytes). */
  | "unanswered_user_message";

export type NoResumeReason =
  /** Nothing conversational is persisted — including every fresh session. */
  | "empty_session"
  /** The tail is a finished turn (or an aborted one, or a shell op). */
  | "settled_tail"
  /** A resume marker already follows the last real user message. */
  | "already_resumed";

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

/** Exactly the marker `AgentSession.sendCustomMessage` is handed. */
export interface TurnResumeMarker {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: {
    readonly shape?: InterruptedTurnShape;
    readonly headRecordId?: string;
  };
}

/** The one AgentSession capability the resume needs. */
export interface ResumeCapableSession {
  sendCustomMessage(message: TurnResumeMarker, options?: { triggerTurn?: boolean }): Promise<void>;
}

export interface TurnResumeError {
  readonly message: string;
}

export interface TurnResumeAttempt {
  readonly decision: TurnResumeDecision;
  /**
   * What boot reports in `RuntimeHealth`, or null for an ordinary boot
   * (docs/lifecycle.md: only notable decisions are reported).
   */
  readonly observation: RuntimeTurnResume | null;
  /** The record appended to the session, or null when boot appended none. */
  readonly marker: TurnResumeMarker | null;
  /**
   * For a resume, settles when the *resumed turn* does, not when the marker is
   * appended: with `triggerTurn` the SDK awaits the whole agent run. Boot must
   * never await this — it is exposed for logging and for tests. A decline
   * settles as soon as its record is persisted.
   */
  readonly issued: ResultAsync<void, TurnResumeError> | null;
}

// -- tail classification ------------------------------------------------------

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
  | { readonly kind: "decline_marker"; readonly id: string | null }
  /** Conversational but not a turn boundary we resume from (shell, compaction, …). */
  | { readonly kind: "other"; readonly id: string | null };

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify one persisted entry. Metadata entries the SDK writes around a
 * session (model/thinking changes, labels, session info, plain custom entries)
 * are invisible to detection: `createAgentSession` appends a
 * `thinking_level_change` when it reopens a session without one, and a verdict
 * that flipped on that would be worthless.
 */
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
          // bashExecution and any future role: shell operations are out of
          // scope, and an unknown role is not an interruption we understand.
          return { kind: "other", id };
      }
    }
    case "custom_message":
      switch (entry["customType"]) {
        case TURN_RESUME_CUSTOM_TYPE:
          return { kind: "resume_marker", id };
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
  if (last.kind === "user") return { shape: "unanswered_user_message", headRecordId: last.id };
  return null;
}

/**
 * Decide, from the session's active branch (root→leaf, e.g.
 * `SessionManager.buildContextEntries()`), whether a turn was interrupted and
 * has not already been auto-resumed once.
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

  // Loop guard: at most one auto-resume per interruption. A marker after the
  // last real user message means this interruption was already resumed once
  // — a turn that keeps crashing its host resumes once, then stays idle.
  const lastUserIndex = tail.findLastIndex((entry) => entry.kind === "user");
  const markerIndex = tail.findLastIndex((entry) => entry.kind === "resume_marker");
  if (markerIndex > lastUserIndex) {
    const dangling = interruptedTail(conversational);
    if (dangling === null) return { resume: false, reason: "already_resumed", suppressed: null };
    const declineIndex = tail.findLastIndex((entry) => entry.kind === "decline_marker");
    return {
      resume: false,
      reason: "already_resumed",
      suppressed: { ...dangling, announced: declineIndex > lastUserIndex },
    };
  }

  const dangling = interruptedTail(conversational);
  if (dangling === null) return { resume: false, reason: "settled_tail" };
  return { resume: true, ...dangling };
}

function optionalDetail(headRecordId: string | null): { headRecordId?: string } {
  return headRecordId === null ? {} : { headRecordId };
}

/**
 * Detect and act: append the resume marker with `triggerTurn` for an
 * interrupted tail, or — when the loop guard suppresses a resume that has not
 * been announced yet — append the visible, non-triggering decline record. The
 * returned attempt is synchronous: the caller (boot) reports ready without
 * waiting, and a resumed turn surfaces as ordinary `busy` activity through the
 * normal agent-event path.
 */
export function startInterruptedTurnResume(
  entries: readonly unknown[],
  session: ResumeCapableSession,
): TurnResumeAttempt {
  const decision = detectInterruptedTurn(entries);
  const plan = planMarker(decision);
  if (plan === null)
    return { decision, observation: observationOf(decision), marker: null, issued: null };

  // The SDK call can throw synchronously as well as reject; both are mapped
  // at this boundary, and neither may escape into the boot path. The call
  // itself is issued synchronously, so the record is queued before boot
  // continues.
  const send = ResultAsync.fromThrowable(
    (): Promise<void> =>
      plan.triggerTurn
        ? session.sendCustomMessage(plan.marker, { triggerTurn: true })
        : session.sendCustomMessage(plan.marker),
    (error): TurnResumeError => ({
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    decision,
    observation: observationOf(decision),
    marker: plan.marker,
    issued: send().map(() => undefined),
  };
}

/** The record this decision appends, if any, and whether it triggers a turn. */
function planMarker(
  decision: TurnResumeDecision,
): { readonly marker: TurnResumeMarker; readonly triggerTurn: boolean } | null {
  if (decision.resume) {
    return {
      marker: {
        customType: TURN_RESUME_CUSTOM_TYPE,
        content: TURN_RESUME_CONTENT,
        display: true,
        details: { shape: decision.shape, ...optionalDetail(decision.headRecordId) },
      },
      triggerTurn: true,
    };
  }
  if (decision.reason !== "already_resumed") return null;
  const suppressed = decision.suppressed;
  // Only a guard that actually holds a dangling turn back is worth telling the
  // user about, and only once per interruption.
  if (suppressed === null || suppressed.announced) return null;
  return {
    marker: {
      customType: TURN_RESUME_DECLINED_CUSTOM_TYPE,
      content: TURN_RESUME_DECLINED_CONTENT,
      display: true,
      details: optionalDetail(suppressed.headRecordId),
    },
    // Deliberately no turn: declining *is* the decision.
    triggerTurn: false,
  };
}

/**
 * The health report for a boot decision (docs/lifecycle.md). A declined resume
 * is reported on every boot that declines, even when the record announcing it
 * is already in history: health describes this boot, the record deduplicates
 * across boots.
 */
function observationOf(decision: TurnResumeDecision): RuntimeTurnResume | null {
  if (decision.resume) {
    return {
      outcome: "resumed",
      shape: decision.shape,
      ...optionalDetail(decision.headRecordId),
    };
  }
  if (decision.reason !== "already_resumed" || decision.suppressed === null) return null;
  return {
    outcome: "declined_already_resumed",
    shape: decision.suppressed.shape,
    ...optionalDetail(decision.suppressed.headRecordId),
  };
}

/** One grep-friendly line per boot resume decision. */
export function describeTurnResumeDecision(decision: TurnResumeDecision): string {
  if (decision.resume) {
    return `turn-resume: resuming interrupted turn shape=${decision.shape} head=${decision.headRecordId ?? "unknown"}`;
  }
  if (decision.reason !== "already_resumed" || decision.suppressed === null) {
    return `turn-resume: no resume reason=${decision.reason}`;
  }
  const { shape, headRecordId, announced } = decision.suppressed;
  return `turn-resume: no resume reason=already_resumed suppressed=${shape} head=${headRecordId ?? "unknown"} announced=${announced}`;
}
