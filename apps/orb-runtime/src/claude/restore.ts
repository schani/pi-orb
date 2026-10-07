import { createHash } from "node:crypto";
import type { ClaudeRecoveryProof, HistoryRecord, JsonObject } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";

export interface ClaudeHandoffTerminal {
  queryId: string;
  operationId: string | null;
  startedId: string;
  notificationId: string;
  sessionId: string;
  status: "completed" | "failed" | "stopped";
  phase: "closing";
  lifetime: string;
}

interface State {
  readonly id?: string;
  readonly deliveries: Readonly<
    Record<string, { uuid: string; operationId: string; submitted: boolean }>
  >;
  readonly guardLifetime?: string;
  readonly ownedChildren?: Readonly<Record<string, string>>;
  readonly ownedTasks?: Readonly<Record<string, string>>;
  readonly ownedBackgroundTasks?: Readonly<Record<string, string>>;
  readonly pendingHandoffs?: Readonly<Record<string, string>>;
}
export interface HandoffRecoveryError {
  readonly type: "claude_handoff_recovery_error";
  readonly stage: "publication" | "persistence";
  readonly message: string;
}

/** Publish interruption before releasing only an exactly matched closing-query handoff. */
export function reconcileClaudeHandoffs(
  state: {
    guardLifetime?: string;
    pendingHandoffs?: Record<string, string>;
    handoffTerminals?: Record<string, ClaudeHandoffTerminal>;
  },
  records: readonly HistoryRecord[],
  lifetime: string,
  publish: (id: string, overflow: JsonObject) => Result<void, { message: string }>,
  save: () => Result<void, { message: string }>,
): Result<string[], HandoffRecoveryError> {
  const released: string[] = [];
  if (state.guardLifetime !== lifetime) return ok(released);
  for (const [taskId, handoff] of Object.entries(state.pendingHandoffs ?? {})) {
    const terminal = state.handoffTerminals?.[taskId];
    if (
      terminal === undefined ||
      terminal.lifetime !== lifetime ||
      terminal.phase !== "closing" ||
      terminal.queryId === "" ||
      terminal.operationId === null ||
      terminal.startedId === "" ||
      terminal.notificationId === "" ||
      terminal.sessionId === ""
    )
      continue;
    const id = `claude.handoff-interrupted:${terminal.queryId}:${taskId}:${terminal.notificationId}`;
    const overflow: JsonObject = {
      queryId: terminal.queryId,
      operationId: terminal.operationId,
      taskId,
      startedId: terminal.startedId,
      notificationId: terminal.notificationId,
      sessionId: terminal.sessionId,
      terminalStatus: terminal.status,
      lifetime,
      phase: terminal.phase,
      disposition: "interrupted",
      automaticReplay: false,
    };
    const existing = records.find((record) => record.id === id);
    if (existing !== undefined) {
      if (
        existing.type !== "event" ||
        existing.eventType !== "claude.handoff_interrupted" ||
        Object.entries(overflow).some(([key, value]) => existing.overflow[key] !== value)
      )
        return err({
          type: "claude_handoff_recovery_error",
          stage: "publication",
          message: "Claude handoff disposition conflicts with retained terminal proof.",
        });
    } else {
      const published = publish(id, overflow);
      if (published.isErr())
        return err({
          type: "claude_handoff_recovery_error",
          stage: "publication",
          ...published.error,
        });
    }
    delete state.pendingHandoffs?.[taskId];
    delete state.handoffTerminals?.[taskId];
    const saved = save();
    if (saved.isErr()) {
      state.pendingHandoffs ??= {};
      state.pendingHandoffs[taskId] = handoff;
      state.handoffTerminals ??= {};
      state.handoffTerminals[taskId] = terminal;
      return err({ type: "claude_handoff_recovery_error", stage: "persistence", ...saved.error });
    }
    released.push(taskId);
  }
  return ok(released);
}

/** Ownership identity only: no lifetime, outputs, prompts or delivery payloads. */
export function claudeRecoveryEpisode(state: State): string {
  const maps = [
    state.ownedChildren,
    state.ownedTasks,
    state.ownedBackgroundTasks,
    state.pendingHandoffs,
  ].map((owners) => Object.keys(owners ?? {}).sort());
  return createHash("sha256")
    .update(
      JSON.stringify([
        state.id ?? "",
        ...maps,
        [
          ...new Set(
            Object.values(state.deliveries)
              .filter((delivery) => delivery.submitted)
              .map((delivery) => delivery.operationId),
          ),
        ].sort(),
      ]),
    )
    .digest("hex");
}

export function reconcileClaudeComputeOwnership(
  state: State & {
    ownedChildren?: Record<string, string>;
    ownedTasks?: Record<string, string>;
    ownedBackgroundTasks?: Record<string, string>;
    pendingHandoffs?: Record<string, string>;
    handoffTerminals?: Record<string, ClaudeHandoffTerminal>;
  },
  records: readonly HistoryRecord[],
  lifetime: string,
  publish: (id: string, overflow: JsonObject) => Result<void, { message: string }>,
  save: () => Result<void, { message: string }>,
  recovery?: { proof: ClaudeRecoveryProof; incarnation: number },
): Result<void, HandoffRecoveryError> {
  const qualified = qualifyClaudeRestart(state, records, lifetime, recovery);
  if (qualified.isErr())
    return err({
      type: "claude_handoff_recovery_error",
      stage: "publication",
      message: qualified.error.message,
    });
  const episode = claudeRecoveryEpisode(state);
  const id = `claude.children-interrupted:${episode}`;
  const children = [
    ...new Set(
      [
        state.ownedChildren,
        state.ownedTasks,
        state.ownedBackgroundTasks,
        state.pendingHandoffs,
      ].flatMap((owners) => Object.keys(owners ?? {})),
    ),
  ].sort();
  if (children.length === 0) return ok(undefined);
  const existing = records.find((record) => record.id === id);
  if (
    existing !== undefined &&
    (existing.type !== "event" ||
      existing.eventType !== "claude.children_interrupted" ||
      existing.overflow.episode !== episode)
  )
    return err({
      type: "claude_handoff_recovery_error",
      stage: "publication",
      message: "Claude compute interruption conflicts with retained ownership.",
    });
  if (existing === undefined) {
    const published = publish(id, {
      episode,
      children,
      ...(state.guardLifetime === undefined ? {} : { previousLifetime: state.guardLifetime }),
      lifetime,
      automaticReplay: false,
    });
    if (published.isErr())
      return err({
        type: "claude_handoff_recovery_error",
        stage: "publication",
        ...published.error,
      });
  }
  const before = {
    ownedChildren: state.ownedChildren,
    ownedTasks: state.ownedTasks,
    ownedBackgroundTasks: state.ownedBackgroundTasks,
    pendingHandoffs: state.pendingHandoffs,
    handoffTerminals: state.handoffTerminals,
  };
  state.ownedChildren = {};
  state.ownedTasks = {};
  state.ownedBackgroundTasks = {};
  state.pendingHandoffs = {};
  state.handoffTerminals = {};
  const saved = save();
  if (saved.isErr()) {
    for (const key of [
      "ownedChildren",
      "ownedTasks",
      "ownedBackgroundTasks",
      "pendingHandoffs",
      "handoffTerminals",
    ] as const) {
      const value = before[key];
      if (value === undefined) delete state[key];
      else Object.assign(state, { [key]: value });
    }
    return err({ type: "claude_handoff_recovery_error", stage: "persistence", ...saved.error });
  }
  return ok(undefined);
}

export interface ClaudePhysicalLifetime {
  readonly kernelBootId: string;
  readonly pid1StartTime: string;
}

/** Only the builder's known procfs identity is evidence; fallback identities are unknown. */
export function parseClaudePhysicalLifetime(
  value: string | undefined,
): ClaudePhysicalLifetime | null {
  if (value === undefined) return null;
  const match =
    /^claude:(?:0|[1-9]\d*):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):(0|[1-9]\d*)$/.exec(
      value,
    );
  // JS '$' also matches before a final newline; require the entire persisted string.
  if (match?.[0] !== value || match[1] === undefined || match[2] === undefined) return null;
  return { kernelBootId: match[1], pid1StartTime: match[2] };
}

function computeLifetimeChanged(before: string | undefined, after: string): boolean {
  const previous = parseClaudePhysicalLifetime(before);
  const current = parseClaudePhysicalLifetime(after);
  return (
    previous !== null &&
    current !== null &&
    (previous.kernelBootId !== current.kernelBootId ||
      previous.pid1StartTime !== current.pid1StartTime)
  );
}

export function qualifyClaudeRestart(
  state: State,
  records: readonly HistoryRecord[],
  lifetime: string,
  recovery?: { proof: ClaudeRecoveryProof; incarnation: number },
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
    !computeLifetimeChanged(state.guardLifetime, lifetime) &&
    !(
      recovery !== undefined &&
      recovery.proof.episode === claudeRecoveryEpisode(state) &&
      recovery.proof.replacementIncarnation === recovery.incarnation &&
      recovery.proof.disposedIncarnation >= 0 &&
      recovery.proof.replacementIncarnation === recovery.proof.disposedIncarnation + 1
    )
  )
    return err({
      code: "claude_child_recovery_required",
      message:
        "Native background work lacks terminal ownership evidence for this execution. Stop the old compute before recovering the retained session.",
    });
  return ok({ interruptedOperations: [...interrupted], orphanedChildren: children });
}
