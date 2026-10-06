import type { HistoryRecord } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";

interface State {
  readonly deliveries: Readonly<
    Record<string, { uuid: string; operationId: string; submitted: boolean }>
  >;
  readonly guardLifetime?: string;
  readonly ownedChildren?: Readonly<Record<string, string>>;
  readonly ownedTasks?: Readonly<Record<string, string>>;
  readonly ownedBackgroundTasks?: Readonly<Record<string, string>>;
  readonly pendingHandoffs?: Readonly<Record<string, string>>;
}
export function qualifyClaudeRestart(
  state: State,
  records: readonly HistoryRecord[],
  lifetime: string,
): Result<
  { interruptedOperations: string[]; orphanedChildren: string[] },
  { code: "claude_delivery_uncertain" | "claude_child_recovery_required"; message: string }
> {
  const interrupted = new Set<string>();
  for (const delivery of Object.values(state.deliveries)) {
    if (!delivery.submitted) continue;
    if (!records.some((record) => record.id === delivery.uuid))
      return err({
        code: "claude_delivery_uncertain",
        message:
          "A submitted message has no durable native receipt. Inspect the retained session before retrying; automatic replay is disabled.",
      });
    if (
      !records.some(
        (record) =>
          record.type === "event" &&
          record.eventType === "claude.operation_finished" &&
          record.overflow.operationId === delivery.operationId,
      )
    )
      interrupted.add(delivery.operationId);
  }
  const children = [
    ...new Set(
      [
        state.ownedChildren,
        state.ownedTasks,
        state.ownedBackgroundTasks,
        state.pendingHandoffs,
      ].flatMap((value) => Object.keys(value ?? {})),
    ),
  ].sort();
  if (
    children.length > 0 &&
    (state.guardLifetime === undefined || state.guardLifetime === lifetime)
  )
    return err({
      code: "claude_child_recovery_required",
      message:
        "Native background work lacks terminal ownership evidence for this execution. Stop the old compute before recovering the retained session.",
    });
  return ok({ interruptedOperations: [...interrupted], orphanedChildren: children });
}
