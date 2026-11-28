import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_REASON_MAX_LENGTH, type GoalView, type JsonObject } from "@pi-orb/protocol";
import { Type } from "typebox";
import { Check } from "typebox/value";

const MAX_CONDITION_LENGTH = 4000;
const clearAliases = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
const conditionSchema = Type.String({
  minLength: 1,
  maxLength: MAX_CONDITION_LENGTH,
  pattern: "\\S",
});

export function goalCondition(input: string): string | null {
  const condition = input.trim();
  return condition.length <= MAX_CONDITION_LENGTH &&
    Check(conditionSchema, condition) &&
    !condition.includes("\0") &&
    !/[\uD800-\uDFFF]/u.test(condition) &&
    !clearAliases.has(condition.toLowerCase())
    ? condition
    : null;
}

const nonnegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const goalStatusSchema = Type.Object(
  {
    type: Type.Literal("goal_status"),
    condition: conditionSchema,
    met: Type.Boolean(),
    sentinel: Type.Optional(Type.Literal(true)),
    failed: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
    iterations: Type.Optional(nonnegativeInteger),
    durationMs: Type.Optional(nonnegativeInteger),
    tokens: Type.Optional(nonnegativeInteger),
  },
  { additionalProperties: false },
);
const nativeGoalSchema = Type.Object({
  type: Type.Literal("attachment"),
  uuid: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }),
  sessionId: Type.String(),
  isSidechain: Type.Literal(false),
  attachment: goalStatusSchema,
});

export interface NativeGoalRecord {
  readonly revision: string;
  readonly condition: string;
  readonly terminal: boolean;
  readonly failed: boolean;
  readonly sentinel: boolean;
  readonly reason?: string;
}

export function nativeGoalRecord(native: JsonObject, sessionId: string): NativeGoalRecord | null {
  if (
    native.type !== "attachment" ||
    native.sessionId !== sessionId ||
    !Check(nativeGoalSchema, native) ||
    goalCondition(native.attachment.condition) !== native.attachment.condition
  )
    return null;
  const { condition, met, failed, reason, sentinel } = native.attachment;
  return {
    revision: native.uuid,
    condition,
    terminal: met || failed === true,
    failed: failed === true,
    sentinel: sentinel === true,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}

export function projectNativeGoal(record: NativeGoalRecord | undefined): GoalView | null {
  if (record === undefined || record.terminal) return null;
  return {
    revision: record.revision,
    objective: record.condition,
    status: "active",
    ...(record.reason === undefined
      ? {}
      : { reason: record.reason.slice(0, GOAL_REASON_MAX_LENGTH) }),
  };
}

const commandRunSchema = Type.Object(
  { command: Type.Literal("goal"), args: Type.String() },
  { additionalProperties: false },
);

const goalEchoMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.String({
    pattern:
      "^<command-name>/goal</command-name>\\s+<command-message>goal</command-message>\\s+<command-args>[\\s\\S]*</command-args>$",
  }),
});

export function isNativeGoalEcho(row: JsonObject, sessionId: string): boolean {
  return (
    row.type === "user" &&
    row.rowSource === "local" &&
    row.isSidechain === false &&
    row.sessionId === sessionId &&
    typeof row.uuid === "string" &&
    row.turnAttributionKey === row.uuid &&
    Check(goalEchoMessageSchema, row.message)
  );
}

export function nativeGoalCommands(
  rows: readonly JsonObject[],
  sessionId: string,
  goals: readonly NativeGoalRecord[],
): ReadonlyMap<string, { goal: NativeGoalRecord; args: string }> {
  const proofs = new Map<string, { goal: NativeGoalRecord; args: string }>();
  if (goals.length === 0) return proofs;
  const sentinels = new Map(
    goals.filter((goal) => goal.sentinel).map((goal) => [goal.revision, goal]),
  );
  const commandParents = new Map<string, NativeGoalRecord>();
  const caveats = new Map<string, NativeGoalRecord>();
  for (const row of rows) {
    if (
      row.sessionId !== sessionId ||
      row.isSidechain !== false ||
      typeof row.parentUuid !== "string" ||
      typeof row.uuid !== "string"
    )
      continue;
    const sentinel = sentinels.get(row.parentUuid);
    if (
      row.type === "user" &&
      row.rowSource === "harness" &&
      row.isMeta === true &&
      sentinel?.terminal
    )
      caveats.set(row.uuid, sentinel);
    else if (isNativeGoalEcho(row, sessionId)) {
      const goal = sentinel ?? caveats.get(row.parentUuid);
      if (goal !== undefined) commandParents.set(row.uuid, goal);
    } else if (
      row.type === "system" &&
      row.subtype === "local_command" &&
      Check(commandRunSchema, row.commandRun)
    ) {
      const goal = commandParents.get(row.parentUuid);
      if (goal !== undefined) proofs.set(row.parentUuid, { goal, args: row.commandRun.args });
    }
  }
  return proofs;
}

export function isNativeGoalFeedback(message: SDKAssistantMessage): boolean {
  return (
    message.parent_tool_use_id === null &&
    message.message.model === "<synthetic>" &&
    "local_command_source" in message &&
    typeof message.local_command_source === "string" &&
    "local_command_run" in message &&
    Check(commandRunSchema, message.local_command_run)
  );
}
