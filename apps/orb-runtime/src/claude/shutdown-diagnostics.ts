import type { JsonObject, JsonValue } from "@pi-orb/protocol";

export type ClaudeCloseCaller =
  | "attach"
  | "initialization_failure"
  | "rate_limit"
  | "operation_drain"
  | "idle_stop"
  | "settings"
  | "settings_failure"
  | "external";
const ownerKinds = [
  "hooks",
  "children",
  "tasks",
  "inventory",
  "handoffs",
  "ownedChildren",
  "ownedTasks",
  "ownedBackgroundTasks",
  "pendingHandoffs",
] as const;
type CloseState = {
  outcome: "completed" | "aborted" | "failed";
  holds: readonly string[];
  ownership: Partial<Record<(typeof ownerKinds)[number], readonly string[]>>;
};
const MAX_IDS = 4;
const bytes = (value: JsonValue) => Buffer.byteLength(JSON.stringify(value));
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
const allowed = (value: unknown, values: readonly string[]) =>
  value == null ? null : typeof value === "string" && values.includes(value) ? value : "other";
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const blocks = (value: unknown) =>
  Array.isArray(value) ? value.map(record).filter((entry) => entry !== null) : [];

/** Volatile close-time evidence, published only in the existing rotation failure event. */
export class ClaudeShutdownDiagnostics {
  private seq = 0;
  private droppedEdges = 0;
  private truncatedFields = 0;
  private initialClose: JsonObject | null = null;
  private readonly edges: JsonObject[] = [];

  private id(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value !== "string" || !/^[A-Za-z0-9:_-]+$/.test(value)) {
      this.truncatedFields++;
      return null;
    }
    if (value.length > 64) this.truncatedFields++;
    return value.slice(0, 64);
  }
  private result(value: Record<string, unknown>): JsonObject {
    return {
      resultId: this.id(value.resultId),
      subtype: allowed(value.subtype, [
        "success",
        "error_during_execution",
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ]),
      isError: flag(value.isError),
      numTurns: number(value.numTurns),
      queuedTurns: number(value.queuedTurns),
      stopReason: allowed(value.stopReason, [
        "end_turn",
        "max_tokens",
        "stop_sequence",
        "tool_use",
        "pause_turn",
        "refusal",
      ]),
    };
  }
  beginClose(caller: ClaudeCloseCaller, result: JsonObject | null, state: CloseState): void {
    if (this.initialClose !== null) return;
    const ownership: JsonObject = {};
    for (const kind of ownerKinds) {
      const ids = state.ownership[kind] ?? [];
      ownership[kind] = {
        count: ids.length,
        ids: ids.slice(0, MAX_IDS).map((value) => this.id(value)),
        omitted: Math.max(0, ids.length - MAX_IDS),
      };
    }
    this.initialClose = {
      seq: ++this.seq,
      caller,
      outcome: state.outcome,
      result: result === null ? null : this.result(result),
      holds: ["root", "hooks", "children", "handoffs", "inventory", "tasks"].filter((hold) =>
        state.holds.includes(hold),
      ),
      ownership,
    };
  }
  observe(value: unknown): void {
    if (this.initialClose === null) return;
    const message = record(value);
    if (message === null) return;
    let fields: JsonObject;
    if (message.type === "user") {
      if (message.parent_tool_use_id != null) return;
      for (const block of blocks(record(message.message)?.content))
        if (block.type === "tool_result")
          this.edge(message, {
            kind: "tool_result",
            toolUseId: this.id(block.tool_use_id),
            isError: block.is_error === undefined ? false : flag(block.is_error),
          });
      return;
    }
    if (message.type === "result")
      fields = {
        kind: "result",
        ...this.result({
          resultId: message.uuid,
          subtype: message.subtype,
          isError: message.is_error,
          numTurns: message.num_turns,
          queuedTurns: message.queued_turn_count,
          stopReason: message.stop_reason,
        }),
      };
    else if (message.type === "assistant" && message.parent_tool_use_id === null) {
      const tools = blocks(record(message.message)?.content).filter(
        (block) => block.type === "tool_use",
      );
      fields = {
        kind: "assistant",
        tools: tools.slice(0, MAX_IDS).map((tool) => ({
          id: this.id(tool.id),
          kind: allowed(tool.name, ["Bash", "Agent", "Task"]),
        })),
        toolsCount: tools.length,
        toolsOmitted: Math.max(0, tools.length - MAX_IDS),
      };
    } else if (message.type === "system") {
      if (message.subtype === "status" && message.status === "requesting")
        fields = { kind: "status", status: "requesting" };
      else if (message.subtype === "task_started" || message.subtype === "task_notification") {
        fields = {
          kind: message.subtype,
          taskId: this.id(message.task_id),
          toolUseId: this.id(message.tool_use_id),
        };
        if (message.subtype === "task_started") {
          fields.taskKind = allowed(message.task_type, [
            "local_agent",
            "local_bash",
            "local_monitor",
            "local_workflow",
            "mcp_task",
          ]);
          fields.ambient = flag(message.ambient);
        } else fields.status = allowed(message.status, ["completed", "failed", "stopped"]);
      } else return;
    } else return;
    this.edge(message, fields);
  }
  private edge(message: Record<string, unknown>, fields: JsonObject): void {
    this.edges.push({ seq: ++this.seq, messageId: this.id(message.uuid), ...fields });
    while (this.edges.length > 32 || bytes(this.snapshot()) > 8192) {
      this.edges.shift();
      this.droppedEdges++;
    }
  }
  snapshot() {
    return {
      initialClose: this.initialClose,
      edges: [...this.edges],
      droppedEdges: this.droppedEdges,
      truncatedFields: this.truncatedFields,
    };
  }
}
