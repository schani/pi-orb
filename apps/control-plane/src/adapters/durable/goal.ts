import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationHandle,
  type ConversationId,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  type EntryId,
  GenerationTask,
  type Harness,
  hook,
  hookTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import { GOAL_OBJECTIVE_MAX_LENGTH, GOAL_REASON_MAX_LENGTH, type GoalView } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";

export const GOAL_REQUEST_PREFIX = "orb-goal:";
export const MAX_GOAL_FOLLOWUPS = 3;

export const GoalInput = defineEntry<{ revision: string; turn: number }>("orb.goal-input");

type GoalState = {
  revision: number;
  goal?: Omit<GoalView, "revision"> & { submissionId: SubmissionId; followUps: number };
  receipts: Record<string, string>;
};

export const GoalDoc = defineDoc<GoalState>({
  kind: "orb.goal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ revision: 0, receipts: {} }),
  checkpointWhen: () => false,
});

type GoalInputSource = UserInput | ((objective: string) => UserInput);

export type GoalAction =
  | { type: "goal_set"; objective: string; input: GoalInputSource }
  | { type: "goal_resume"; revision: string; input: GoalInputSource }
  | { type: "goal_pause" | "goal_clear"; revision: string };

export type GoalError =
  | {
      type: "goal_error";
      code:
        | "root_only"
        | "goal_exists"
        | "no_goal"
        | "invalid_objective"
        | "invalid_status"
        | "stale_revision"
        | "request_conflict"
        | "durable_failure";
    }
  | { type: "goal_error"; code: "admission_denied"; reason: string };

export type GoalAdmissionRefusal = { disposition: "sleep" | "denied"; reason: string };

export type GoalAdmission = (
  context: Context,
) => Result<void, GoalAdmissionRefusal> | PromiseLike<Result<void, GoalAdmissionRefusal>>;

function failure(code: Exclude<GoalError["code"], "admission_denied">): GoalError {
  return { type: "goal_error", code };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: PostgreSQL JSONB cannot store NUL
const INVALID_GOAL_TEXT = /[\u0000\uD800-\uDFFF]/gu;

export function cleanGoalReason(reason: string | undefined) {
  const clean = reason?.replace(INVALID_GOAL_TEXT, "").trim();
  return (clean && [...clean].slice(0, GOAL_REASON_MAX_LENGTH).join("").trimEnd()) || undefined;
}

function interruptionReason(reason: string): string {
  switch (reason) {
    case "aborted":
      return "Goal turn was aborted.";
    case "no_model":
      return "No model was available.";
    case "model_error":
      return "The model could not finish the goal turn.";
    case "turn_limit":
      return "The goal turn reached the model's limit.";
    default:
      return "Goal turn was interrupted.";
  }
}

function nativeRequest(revision: string, turn: number) {
  return `${GOAL_REQUEST_PREFIX}${revision}:${turn}`;
}

function belongsToGoal(state: GoalState, submission: SubmissionRecord | undefined) {
  return submission?.type === "input" &&
    submission.conversationId === ROOT_CONVERSATION_ID &&
    submission.id === state.goal?.submissionId &&
    submission.requestId === nativeRequest(String(state.revision), state.goal.followUps)
    ? submission
    : undefined;
}

/** Native unsuccessful settlement needs no second scheduler or writer to be visible. */
export function goalView(
  state: Readonly<GoalState> | undefined,
  submission?: SubmissionRecord,
): GoalView | undefined {
  const goal = state?.goal;
  if (!goal) return undefined;
  const native = goal.status === "active" ? belongsToGoal(state, submission) : undefined;
  const stopped = native?.status === "unanswered";
  const status = stopped ? "paused" : goal.status;
  const reason = stopped ? interruptionReason(native.reason) : goal.reason;
  return {
    revision: stopped ? `${state.revision}:interrupted` : String(state.revision),
    objective: goal.objective,
    status,
    ...(reason ? { reason } : {}),
  };
}

function currentSubmission(tx: Tx, state: GoalState) {
  return state.goal?.status === "active" ? tx.submission(state.goal.submissionId) : undefined;
}

export function readGoal(
  harness: Harness,
  context: Context,
): ResultAsync<GoalView | undefined, GoalError> {
  return ResultAsync.fromThrowable(
    async () => {
      const snapshot = await harness.snapshot(GoalDoc, ROOT_CONVERSATION_ID, context);
      // Tx.doc() creates a missing document. Only pair the reads once an active goal exists.
      if (snapshot?.goal?.status !== "active") return goalView(snapshot);
      return harness.commit(async (tx) => {
        const state = await tx.doc(GoalDoc, ROOT_CONVERSATION_ID);
        return goalView(state, await currentSubmission(tx, state));
      }, context);
    },
    () => failure("durable_failure"),
  )();
}

function stopGoal(state: GoalState, status: "paused" | "blocked" | "complete", reason?: string) {
  const goal = state.goal;
  if (!goal) return;
  state.revision++;
  goal.status = status;
  const cleaned = cleanGoalReason(reason);
  if (cleaned) goal.reason = cleaned;
  else delete goal.reason;
}

async function withdrawGoal(tx: Tx, state: GoalState, submission: SubmissionRecord | undefined) {
  const goal = belongsToGoal(state, submission);
  if (goal?.status !== "queued") return;
  const { items } = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
  const index = items.findIndex(
    (item) =>
      item.id === goal.id && item.mode === "followUp" && item.entry?.kind === GoalInput.kind,
  );
  if (index < 0) return;
  items.splice(index, 1);
  tx.settleSubmission(goal.id, { status: "unanswered", reason: "aborted" });
}

function admitGoal(
  conversation: Pick<ConversationHandle, "admit">,
  tx: Tx,
  revision: string,
  turn: number,
  input: UserInput,
) {
  return conversation.admit(tx, {
    type: "input",
    whenBusy: "followUp",
    content: input,
    requestId: nativeRequest(revision, turn),
    entry: { kind: GoalInput.kind, data: { revision, turn } },
  });
}

type GoalChange = { goal: GoalView | undefined; duplicate: boolean };

export function changeGoal(
  conversation: Conversation,
  requestId: string,
  action: GoalAction,
  context: Context,
  admission?: GoalAdmission,
): ResultAsync<GoalChange, GoalError> {
  return ResultAsync.fromThrowable(
    () =>
      conversation.commit<Result<GoalChange, GoalError>>(async (tx) => {
        if (conversation.id !== ROOT_CONVERSATION_ID) return err(failure("root_only"));
        if (action.type === "goal_set" && action.objective.search(INVALID_GOAL_TEXT) !== -1)
          return err(failure("invalid_objective"));
        const state = await tx.doc(GoalDoc, conversation.id);
        const key = createHash("sha256").update(JSON.stringify(requestId)).digest("hex");
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              action.type,
              action.type === "goal_set" ? action.objective : action.revision,
            ]),
          )
          .digest("hex");
        const existing = state.receipts[key];
        if (existing !== undefined && existing !== fingerprint)
          return err(failure("request_conflict"));
        const submission = await currentSubmission(tx, state);
        const current = goalView(state, submission);
        if (existing !== undefined) return ok({ goal: current, duplicate: true });

        if (action.type === "goal_set") {
          if (current) return err(failure("goal_exists"));
        } else {
          if (!current) return err(failure("no_goal"));
          if (action.revision !== current.revision) return err(failure("stale_revision"));
        }

        if (action.type === "goal_set" || action.type === "goal_resume") {
          if (
            action.type === "goal_resume" &&
            current?.status !== "paused" &&
            current?.status !== "blocked"
          )
            return err(failure("invalid_status"));
          const objective =
            action.type === "goal_set" ? action.objective.trim() : current?.objective;
          if (!objective || [...objective].length > GOAL_OBJECTIVE_MAX_LENGTH)
            return err(failure("invalid_objective"));
          const allowed = await admission?.(context);
          if (allowed?.isErr())
            return err({
              type: "goal_error",
              code: "admission_denied",
              reason: allowed.error.reason,
            });
          const revision = state.revision + 1;
          const input = typeof action.input === "function" ? action.input(objective) : action.input;
          const submissionId = await admitGoal(conversation, tx, String(revision), 0, input);
          state.revision = revision;
          state.goal = { objective, status: "active", submissionId, followUps: 0 };
        } else if (action.type === "goal_pause") {
          if (current?.status !== "active") return err(failure("invalid_status"));
          await withdrawGoal(tx, state, submission);
          stopGoal(state, "paused");
        } else {
          if (current?.status === "active") return err(failure("invalid_status"));
          state.revision++;
          delete state.goal;
        }

        state.receipts[key] = fingerprint;
        return ok({ goal: goalView(state), duplicate: false });
      }, context),
    () => failure("durable_failure"),
  )().andThen((result) => result);
}

type GoalIdentity = { revision: string; submissionId: SubmissionId };
export type GoalReportIdentity = GoalIdentity & { status: "placed" | "done" };

function isCurrent(state: GoalState, identity: GoalIdentity) {
  return (
    state.goal?.status === "active" &&
    state.goal.submissionId === identity.submissionId &&
    String(state.revision) === identity.revision
  );
}

/** Called inside the commit fenced by the reporting invocation. */
export async function recordGoalResult(
  tx: Tx,
  conversationId: ConversationId,
  identity: GoalReportIdentity,
  result: { status: "complete" | "blocked"; reason?: string },
): Promise<Result<GoalView | undefined, GoalError>> {
  if (conversationId !== ROOT_CONVERSATION_ID) return err(failure("root_only"));
  const state = await tx.doc(GoalDoc, conversationId);
  if (!isCurrent(state, identity)) return err(failure("stale_revision"));
  const run = (await tx.doc(LiveDoc, conversationId)).run;
  if (!run) return err(failure("invalid_status"));
  const ownInput = belongsToGoal(state, await tx.submission(identity.submissionId));
  const inCurrentRun = run.inputs.includes(identity.submissionId);
  if (ownInput?.status !== identity.status || inCurrentRun !== (identity.status === "placed"))
    return err(failure("invalid_status"));
  stopGoal(state, result.status, result.reason);
  return ok(goalView(state));
}

type Continuation = GoalIdentity & { answer: EntryId };
type Decision =
  | "superseded"
  | "different_answer"
  | "deferred_sleep"
  | "pending_input"
  | "pending_reset"
  | "turn_limit"
  | "admission_denied"
  | "continued";
const finished = (result: Decision) => ({
  status: "terminal" as const,
  outcome: { status: "completed" as const, result },
});

/** Registration alone adds no tools or prompt sections. */
export function goalExtension(followUp: (goal: GoalView) => UserInput, admission?: GoalAdmission) {
  const Continue = defineTask<Continuation, { phase: "continue" }, Decision>({
    name: "orb.goal-after-run",
    version: 1,
    initial: () => ({ phase: "continue" }),
    phases: {
      async continue({ input }, runtime, context) {
        const root =
          runtime.conversationId === ROOT_CONVERSATION_ID
            ? await runtime.conversation(ROOT_CONVERSATION_ID, context)
            : undefined;
        await runtime.commit(async (tx) => {
          if (!root) return finished("superseded");
          const state = await tx.doc(GoalDoc, root.id);
          const goal = state.goal;
          const view = goalView(state);
          if (!goal || !view || !isCurrent(state, input)) return finished("superseded");
          const settled = belongsToGoal(state, await tx.submission(goal.submissionId));
          if (settled?.status !== "done" || settled.answer !== input.answer)
            return finished("different_answer");

          const allowed = await admission?.(context);
          if (allowed?.isErr() && allowed.error.disposition === "sleep")
            return finished("deferred_sleep");

          const { items } = await tx.doc(InboxDoc, root.id);
          const pending = items.some((item) => item.mode === "write" && item.entry.head === "self")
            ? "pending_reset"
            : items.some((item) => item.mode !== "write")
              ? "pending_input"
              : undefined;
          if (pending) {
            stopGoal(
              state,
              "paused",
              pending === "pending_input"
                ? "Other input was queued."
                : "A context reset was queued.",
            );
            return finished(pending);
          }
          if (goal.followUps >= MAX_GOAL_FOLLOWUPS) {
            stopGoal(state, "blocked", "Automatic turn limit reached.");
            return finished("turn_limit");
          }
          if (allowed?.isErr()) {
            stopGoal(
              state,
              "paused",
              cleanGoalReason(allowed.error.reason) ?? "Goal continuation was not admitted.",
            );
            return finished("admission_denied");
          }

          const turn = goal.followUps + 1;
          goal.submissionId = await admitGoal(root, tx, input.revision, turn, followUp(view));
          goal.followUps = turn;
          return finished("continued");
        }, context);
      },
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  return defineExtension({
    name: "orb.goal",
    tasks: [Continue],
    hooks: [
      hook(GenerationTask, {
        async afterRun(run, api, context) {
          if (api.conversationId !== ROOT_CONVERSATION_ID) return;
          const state = await api.snapshot(GoalDoc, api.conversationId, context);
          if (state?.goal?.status !== "active") return;
          return {
            tasks: [
              hookTask(Continue, {
                revision: String(state.revision),
                submissionId: state.goal.submissionId,
                answer: run.answer,
              }),
            ],
          };
        },
      }),
    ],
  });
}
