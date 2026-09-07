import {
  detectInterruptedTurn,
  type InterruptedTurnShape,
  TURN_RESUME_CUSTOM_TYPE,
  TURN_RESUME_DECLINED_CONTENT,
  TURN_RESUME_DECLINED_CUSTOM_TYPE,
} from "./turn-resume.ts";

/** Execution identity survives runtime-only restarts, but not host/container restarts. */
export interface BootIdentity {
  readonly runtimeInstanceId: string;
  readonly executionId: string | null;
  readonly incarnation: string;
}

export const BOOT_BASELINE_TYPE = "pi-orb.boot";
export const HOST_RESTARTED_TYPE = "pi-orb.host-restarted";
export const HOST_RESTART_CONTEXT =
  "The host was restarted. All processes running before the restart were killed, including servers, background jobs, and shell sessions.";
export const RUNTIME_RESTART_CONTEXT =
  "The agent runtime was restarted. Other processes may still be running; verify their state rather than assuming they survived or died.";
const SETTLED_INSTRUCTION =
  "Reassess any assumptions about running processes; restart only what is still needed for the user's task. Do not repeat completed work. Do not resume aborted work.";

export type BootNotificationPlan =
  | { readonly kind: "none" }
  | { readonly kind: "baseline"; readonly identity: BootIdentity }
  | {
      readonly kind: "message";
      readonly triggerTurn: boolean;
      readonly marker: {
        readonly customType: string;
        readonly content: string;
        readonly display: true;
        readonly details: BootIdentity & {
          readonly reason:
            | "host_restarted"
            | "runtime_restarted"
            | "resumed"
            | "declined_already_resumed";
          readonly headRecordId: string | null;
          readonly shape?: InterruptedTurnShape;
          readonly previousRuntimeInstanceId: string | null;
        };
      };
    };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Full session entries, not compacted model context, retain the latest boot identity. */
function lastBoot(entries: readonly unknown[]): BootIdentity | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = object(entries[index]);
    if (entry === null) continue;
    const type = entry["customType"];
    if (
      ![
        BOOT_BASELINE_TYPE,
        HOST_RESTARTED_TYPE,
        TURN_RESUME_CUSTOM_TYPE,
        TURN_RESUME_DECLINED_CUSTOM_TYPE,
      ].includes(String(type))
    )
      continue;
    const data = object(entry[entry["type"] === "custom" ? "data" : "details"]);
    if (
      data === null ||
      typeof data["runtimeInstanceId"] !== "string" ||
      typeof data["incarnation"] !== "string"
    )
      continue;
    return {
      runtimeInstanceId: data["runtimeInstanceId"],
      incarnation: data["incarnation"],
      executionId: typeof data["executionId"] === "string" ? data["executionId"] : null,
    };
  }
  return null;
}

/**
 * One pure boot decision. No separate delivered stamp: the message itself is
 * both the context and the guard, including a crash after append but before
 * inference. Only initial, non-conversational boots write a silent baseline.
 */
export function planBootNotification(
  entries: readonly unknown[],
  context: readonly unknown[],
  identity: BootIdentity,
): BootNotificationPlan {
  const previous = lastBoot(entries);
  if (previous?.runtimeInstanceId === identity.runtimeInstanceId) return { kind: "none" };
  const conversational = entries.some((raw) => {
    const entry = object(raw);
    return entry?.["type"] === "message" || entry?.["type"] === "custom_message";
  });
  if (!conversational) return { kind: "baseline", identity };

  const hostRestarted =
    previous !== null &&
    previous.executionId !== null &&
    identity.executionId !== null &&
    (previous.incarnation !== identity.incarnation ||
      previous.executionId !== identity.executionId);
  const restartContext = hostRestarted ? HOST_RESTART_CONTEXT : RUNTIME_RESTART_CONTEXT;
  // pi-orb has one linear session. Compaction changes model context, not
  // whether a real user granted a new automatic-turn budget. Consult the
  // original records so a compacted-away marker cannot reopen a crash loop.
  const resume = detectInterruptedTurn(
    entries.filter((entry) => object(entry)?.["type"] !== "compaction"),
  );
  const declined =
    !resume.resume && resume.reason === "already_resumed" && resume.suppressed !== null;
  const head = object(context[context.length - 1]);
  return {
    kind: "message",
    triggerTurn: !declined,
    marker: {
      customType: resume.resume
        ? TURN_RESUME_CUSTOM_TYPE
        : declined
          ? TURN_RESUME_DECLINED_CUSTOM_TYPE
          : HOST_RESTARTED_TYPE,
      content: `${restartContext} ${
        resume.resume
          ? "The previous turn was interrupted — resuming it now. Continue from where you left off."
          : declined
            ? TURN_RESUME_DECLINED_CONTENT
            : SETTLED_INSTRUCTION
      }`,
      display: true,
      details: {
        ...identity,
        reason: resume.resume
          ? "resumed"
          : declined
            ? "declined_already_resumed"
            : hostRestarted
              ? "host_restarted"
              : "runtime_restarted",
        headRecordId: resume.resume
          ? resume.headRecordId
          : typeof head?.["id"] === "string"
            ? head["id"]
            : null,
        previousRuntimeInstanceId: previous?.runtimeInstanceId ?? null,
        ...(resume.resume ? { shape: resume.shape } : {}),
      },
    },
  };
}
