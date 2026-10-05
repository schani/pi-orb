import {
  getActivityHeadlineSource,
  type HistoryRecord,
  projectDisplayRecords,
  projectRecordDetail,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { ActivityHeadlineRef, StoredActivityHeadline } from "./activity-headline-store.ts";
import { sleepResult, withDeadline } from "./dst.ts";
import { logOrbEvent } from "./log.ts";
import type {
  ActivityHeadlineFailureDiagnostics,
  ActivityHeadlineGenerationError,
  ControlPlaneDeps,
  OperationContext,
} from "./ports.ts";

export type ActivityHeadlineError = {
  readonly type:
    | "orb_missing"
    | "detail_missing"
    | "invalid_session"
    | "ineligible"
    | "unavailable"
    | "cancelled";
  readonly stage: "source" | "inference" | "persistence";
};

/** Each request owns its budget and inference. Atomic insertion, not shared work, selects a winner. */
export function generateActivityHeadline(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  ref: ActivityHeadlineRef,
  caller?: OperationContext,
  correlationId?: string,
): ResultAsync<StoredActivityHeadline, ActivityHeadlineError> {
  const admitted = task.monotonicNow();
  const expires = admitted + 30_000;
  let stage: ActivityHeadlineError["stage"] = "source";
  let cacheHit = false;
  let winner = false;
  let attempts = 0;
  let diagnostics: ActivityHeadlineFailureDiagnostics = {};
  let failureStage: string | undefined;
  let termination:
    | "succeeded"
    | "retry_exhausted"
    | "not_retriable"
    | "cancelled"
    | "deadline_exceeded" = "not_retriable";
  const diagnosticFields = () => ({
    attempts,
    termination,
    failure_stage: failureStage,
    provider_reason: diagnostics.reason,
    provider_status: diagnostics.providerStatus,
    provider_transport: diagnostics.transport,
    provider_phase: diagnostics.phase,
    provider_stop_reason: diagnostics.stopReason,
    provider_error_code: diagnostics.errorCode,
    input_tokens: diagnostics.inputTokens,
    output_tokens: diagnostics.outputTokens,
    reasoning_tokens: diagnostics.reasoningTokens,
  });
  return withDeadline(task, 30_000, "activity headline", (deadline) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    deadline.signal.addEventListener("abort", abort, { once: true });
    caller?.signal.addEventListener("abort", abort, { once: true });
    if (deadline.signal.aborted || caller?.signal.aborted) abort();
    const signal = controller.signal;
    const cleanup = () => {
      deadline.signal.removeEventListener("abort", abort);
      caller?.signal.removeEventListener("abort", abort);
    };
    const stopped = (): ActivityHeadlineError | null => {
      if (!signal.aborted && task.monotonicNow() < expires) return null;
      termination = caller?.signal.aborted === true ? "cancelled" : "deadline_exceeded";
      return { type: caller?.signal.aborted === true ? "cancelled" : "unavailable", stage };
    };
    const state = async (
      exact: boolean,
    ): Promise<Result<import("./orb.ts").ProjectRow, ActivityHeadlineError>> => {
      const stop = stopped();
      if (stop !== null) return err(stop);
      const orb = await deps.store.getOrb(task, ref.orbId);
      if (orb.isErr()) return err({ type: "unavailable", stage });
      if (orb.value === null || orb.value.state === "deleting")
        return err({ type: "orb_missing", stage });
      if (
        (exact || orb.value.harnessSessionId !== null) &&
        orb.value.harnessSessionId !== ref.sessionId
      )
        return err({ type: "invalid_session", stage });
      const after = stopped();
      if (after !== null) return err(after);
      const project = await deps.store.getProject(task, orb.value.projectId);
      if (project.isErr()) return err({ type: "unavailable", stage });
      if (project.value === null || project.value.state === "deleting")
        return err({ type: "orb_missing", stage });
      return ok(project.value);
    };
    const run = async (): Promise<Result<StoredActivityHeadline, ActivityHeadlineError>> => {
      const initial = await state(false);
      if (initial.isErr()) return err(initial.error);
      let stop = stopped();
      if (stop !== null) return err(stop);
      const cache = await deps.store.readActivityHeadline(task, ref);
      stop = stopped();
      if (stop !== null) return err(stop);
      if (cache.isErr()) return err({ type: "unavailable", stage });
      if (cache.value !== null) {
        const current = await state(true);
        if (current.isErr()) return err(current.error);
        stop = stopped();
        if (stop !== null) return err(stop);
        cacheHit = true;
        return ok(cache.value);
      }
      for (;;) {
        stop = stopped();
        if (stop !== null) return err(stop);
        const target = await deps.store.readHistoryRecord(
          task,
          ref.orbId,
          ref.sessionId,
          ref.recordId,
        );
        stop = stopped();
        if (stop !== null) return err(stop);
        if (target.isErr()) return err({ type: "unavailable", stage });
        if (target.value !== null) break;
        const remaining = expires - task.monotonicNow();
        if (remaining <= 0) return err(stopped() ?? { type: "unavailable", stage });
        const slept = await sleepResult(
          task,
          Math.min(1_000, remaining),
          "headline source replication",
          signal,
        );
        if (slept.isErr()) return err(stopped() ?? { type: "cancelled", stage });
      }
      stop = stopped();
      if (stop !== null) return err(stop);
      const snapshot = await deps.store.readHistorySnapshot(task, ref.orbId, ref.recordId);
      stop = stopped();
      if (stop !== null) return err(stop);
      if (snapshot.isErr()) return err({ type: "unavailable", stage });
      if (snapshot.value.session?.id !== ref.sessionId)
        return err({ type: "invalid_session", stage });
      const source = getActivityHeadlineSource(snapshot.value.records, ref.recordId, ref.detailKey);
      if (source === null) {
        const record = snapshot.value.records.find((record) => record.id === ref.recordId);
        return err({
          type:
            record === undefined || projectRecordDetail(record, ref.detailKey) === null
              ? "detail_missing"
              : "ineligible",
          stage,
        });
      }
      const current = await state(true);
      if (current.isErr()) return err(current.error);
      stop = stopped();
      if (stop !== null) return err(stop);
      stage = "inference";
      let generated: Result<string, ActivityHeadlineGenerationError>;
      for (;;) {
        stop = stopped();
        if (stop !== null) return err(stop);
        attempts++;
        generated = await deps.headlineGenerator.generate(
          task,
          { ownerUserId: current.value.ownerUserId, source },
          { signal, deadlineAt: expires },
        );
        if (generated.isErr()) {
          diagnostics = generated.error;
          failureStage = generated.error.stage;
        }
        stop = stopped();
        if (stop !== null) return err(stop);
        if (generated.isOk()) break;
        const retryable =
          generated.error.stage === "inference" &&
          generated.error.reason === "provider_error" &&
          generated.error.providerStatus === 503;
        termination =
          generated.error.stage === "cancelled"
            ? "cancelled"
            : retryable && attempts === 3
              ? "retry_exhausted"
              : "not_retriable";
        if (!retryable || attempts === 3)
          return err({
            type: generated.error.stage === "cancelled" ? "cancelled" : "unavailable",
            stage,
          });
        const delay = attempts * 1_000;
        logOrbEvent(task, ref.orbId, "headline.retry_scheduled", {
          session: ref.sessionId,
          record: ref.recordId,
          detail: ref.detailKey,
          correlation: correlationId,
          attempt: attempts,
          delay_ms: delay,
          provider_status: 503,
          provider_reason: diagnostics.reason,
          model: "gpt-6-luna",
          elapsed_ms: task.monotonicNow() - admitted,
        });
        const slept = await sleepResult(
          task,
          Math.min(delay, expires - task.monotonicNow()),
          "headline provider retry",
          signal,
        );
        stop = stopped();
        if (stop !== null) return err(stop);
        if (slept.isErr()) {
          termination = "cancelled";
          return err({ type: "cancelled", stage });
        }
      }
      stage = "persistence";
      const valid = await state(true);
      if (valid.isErr()) return err(valid.error);
      stop = stopped();
      if (stop !== null) return err(stop);
      const candidate = { ...ref, headline: generated.value, generatedAt: task.wallNow() };
      const stored = await deps.store.putActivityHeadlineIfAbsent(task, candidate);
      stop = stopped();
      if (stop !== null) return err(stop);
      if (stored.isErr() || stored.value === null) return err({ type: "unavailable", stage });
      winner =
        stored.value.headline === candidate.headline &&
        stored.value.generatedAt === candidate.generatedAt;
      return ok(stored.value);
    };
    return new ResultAsync(run())
      .map((value) => {
        cleanup();
        return value;
      })
      .mapErr((error) => {
        cleanup();
        return error;
      });
  })
    .map((value) => {
      termination = "succeeded";
      if (!cacheHit)
        logOrbEvent(task, ref.orbId, "headline.completed", {
          session: ref.sessionId,
          record: ref.recordId,
          detail: ref.detailKey,
          correlation: correlationId,
          stage,
          outcome: "stored",
          model: "gpt-6-luna",
          winner,
          generated_at: value.generatedAt,
          ...diagnosticFields(),
          elapsed_ms: task.monotonicNow() - admitted,
        });
      return value;
    })
    .mapErr((error) => {
      if (caller?.signal.aborted) termination = "cancelled";
      else if (task.monotonicNow() >= expires) termination = "deadline_exceeded";
      logOrbEvent(task, ref.orbId, "headline.completed", {
        session: ref.sessionId,
        record: ref.recordId,
        detail: ref.detailKey,
        correlation: correlationId,
        stage: error.stage,
        outcome: error.type,
        model: "gpt-6-luna",
        winner: false,
        ...diagnosticFields(),
        elapsed_ms: task.monotonicNow() - admitted,
      });
      return error;
    });
}

/** Cache enrichment is best-effort; a failed read never holds history behind inference. */
export function enrichActivityHeadlines(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  sessionId: string | null,
  records: readonly HistoryRecord[],
): ResultAsync<ReturnType<typeof projectDisplayRecords>, never> {
  const projected = projectDisplayRecords(records);
  if (sessionId === null) return ResultAsync.fromSafePromise(Promise.resolve(projected));
  return new ResultAsync(
    deps.store
      .readActivityHeadlines(task, orbId, sessionId)
      .match(
        (cached) => {
          const headlines = new Map(
            cached.map((value) => [`${value.recordId}\0${value.detailKey}`, value.headline]),
          );
          return projected.map((record) => {
            const lookup = <T extends object>(block: T): T => {
              if (!("headline" in block) || block.headline !== null || !("detailKey" in block))
                return block;
              const headline = headlines.get(`${record.id}\0${block.detailKey}`);
              return headline !== undefined ? { ...block, headline } : block;
            };
            return {
              ...record,
              ...((record.type === "message" || record.type === "event") &&
              record.content !== undefined
                ? { content: record.content.map((block) => lookup(block)) }
                : {}),
              ...(record.type === "event" && record.subagent !== undefined
                ? { subagent: lookup(record.subagent) }
                : {}),
            };
          });
        },
        () => projected,
      )
      .then((value) => ok(value)),
  );
}
