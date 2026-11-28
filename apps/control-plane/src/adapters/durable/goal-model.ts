import {
  defineTool,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { GOAL_REASON_MAX_LENGTH, type GoalView } from "@pi-orb/protocol";
import { ResultAsync } from "neverthrow";
import { Type } from "typebox";
import {
  cleanGoalReason,
  GoalDoc,
  GoalInput,
  type GoalReportIdentity,
  recordGoalResult,
} from "./goal.ts";
import { errorResult } from "./tools/catalog.ts";

const reportInstructions =
  "Mark it complete only after verifying the objective, or blocked if you cannot make further progress. Include the evidence or blocker.";

export const goalModelPolicy = {
  kickoff: (objective: string) =>
    `Work toward the goal below. ${reportInstructions}\n\n${objective}`,
  followUp: ({ objective }: GoalView) => `Continue working toward this goal:\n\n${objective}`,
};

const toolName = "report_goal";
const text = Type.String({ minLength: 1, maxLength: GOAL_REASON_MAX_LENGTH, pattern: "\\S" });

async function goalForInvocation(
  tx: Tx,
  api: ToolExecutionApi,
  fallback: GoalReportIdentity,
): Promise<GoalReportIdentity | undefined> {
  const live = await tx.doc(LiveDoc, api.conversationId);
  const nested = live.nestedTools?.find(
    (slot) => slot.taskId === api.taskId && slot.callId === api.callId && slot.name === toolName,
  );
  if (!live.run || nested?.status !== "running") return;
  const parent = live.tools?.find(
    (slot) => slot.taskId === nested.parentTaskId && slot.name === "codemode",
  );
  if (parent?.status !== "running") return;
  if ((await tx.task(nested.parentTaskId))?.owner !== live.run.taskId) return;

  // Keep a placed goal input tied to its own revision, even if it was superseded.
  for (const submissionId of live.run.inputs) {
    const input = await tx.submission(submissionId);
    if (input?.type !== "input" || input.status !== "placed") continue;
    const entry = await tx.entry(GoalInput, input.entry);
    if (entry) return { revision: entry.data.revision, submissionId, status: "placed" };
  }
  return fallback;
}

export const reportGoalTool = defineTool({
  name: toolName,
  description: reportInstructions,
  callers: ["tools"],
  parameters: Type.Union([
    Type.Object(
      { status: Type.Literal("complete"), evidence: text },
      { additionalProperties: false },
    ),
    Type.Object({ status: Type.Literal("blocked"), reason: text }, { additionalProperties: false }),
  ]),
  replay: "unsafe",
  execute: async (args, api, context) => {
    const rejected = () =>
      errorResult({ code: "forbidden", message: "Goal results require the current goal turn." });
    if (api.conversationId !== ROOT_CONVERSATION_ID) return rejected();
    const reason = cleanGoalReason(args.status === "complete" ? args.evidence : args.reason);
    if (!reason)
      return errorResult({ code: "invalid_arguments", message: "Evidence or reason is required." });

    const recorded = await ResultAsync.fromThrowable(
      async () => {
        const state = await api.snapshot(GoalDoc, api.conversationId, context);
        if (state?.goal?.status !== "active") return false;
        // Without a matching placed input, the report requires a previously settled goal turn.
        const fallback = {
          revision: String(state.revision),
          submissionId: state.goal.submissionId,
          status: "done",
        } as const;
        return api.commit(async (tx) => {
          const identity = await goalForInvocation(tx, api, fallback);
          if (!identity) return false;
          const result = await recordGoalResult(tx, api.conversationId, identity, {
            status: args.status,
            reason,
          });
          return result.isOk();
        }, context);
      },
      () => ({ code: "unavailable" as const, message: "Could not record goal result." }),
    )();
    if (recorded.isErr()) return errorResult(recorded.error);
    if (!recorded.value) return rejected();
    return { output: [{ type: "text", text: `Goal ${args.status}.` }] };
  },
});
