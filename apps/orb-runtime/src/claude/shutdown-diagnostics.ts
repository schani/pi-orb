import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
type Ownership = Partial<Record<(typeof ownerKinds)[number], readonly string[]>>;
type CloseState = {
  outcome: "completed" | "aborted" | "failed";
  holds: readonly string[];
  ownership: Ownership;
};
const MAX_ENTRIES = 48;
const MAX_EDGE_BYTES = 8192;
const MAX_CLOSE_BYTES = 6144;
const MAX_BYTES = 16384;
const MAX_IDS = 8;
const MAX_ID_LENGTH = 64;
const bytes = (value: JsonValue) => Buffer.byteLength(JSON.stringify(value));
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const allowed = (value: unknown, values: readonly string[]) =>
  value == null ? null : typeof value === "string" && values.includes(value) ? value : "other";
const taskKind = (value: unknown) =>
  allowed(value, ["local_agent", "local_bash", "local_monitor", "local_workflow", "mcp_task"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const toolKind = (value: unknown) => allowed(value, ["Bash", "Agent", "Task"]);

/** Volatile, content-free query evidence. Only rotation failures publish a snapshot. */
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
    if (value.length > MAX_ID_LENGTH) this.truncatedFields++;
    return value.slice(0, MAX_ID_LENGTH);
  }
  private ids(values: readonly string[]): JsonObject {
    return {
      count: values.length,
      ids: values.slice(0, MAX_IDS).map((value) => this.id(value)),
      omitted: Math.max(0, values.length - MAX_IDS),
    };
  }
  private records(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      this.truncatedFields++;
      return [];
    }
    const records: Record<string, unknown>[] = [];
    for (const entry of value) {
      const object = record(entry);
      if (object === null) this.truncatedFields++;
      else records.push(object);
    }
    return records;
  }
  private result(value: JsonObject): JsonObject {
    return {
      resultId: this.id(value.resultId),
      subtype: allowed(value.subtype, [
        "success",
        "error_during_execution",
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ]),
      isError: typeof value.isError === "boolean" ? value.isError : null,
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
    const ownership: Record<string, JsonObject> = {};
    for (const kind of ownerKinds) ownership[kind] = this.ids(state.ownership[kind] ?? []);
    this.initialClose = {
      seq: ++this.seq,
      caller,
      outcome: state.outcome,
      result: result === null ? null : this.result(result),
      holds: state.holds.filter((hold) =>
        ["root", "hooks", "children", "handoffs", "inventory", "tasks"].includes(hold),
      ),
      ownership,
    };
    // Keep full counts when the combined close budget requires fewer identity samples.
    for (const owners of Object.values(ownership)) {
      while (
        bytes(this.initialClose) > MAX_CLOSE_BYTES &&
        Array.isArray(owners.ids) &&
        owners.ids.length > 0
      ) {
        owners.ids.pop();
        owners.omitted = (owners.omitted as number) + 1;
      }
    }
  }
  observe(message: SDKMessage, closing: boolean): void {
    let fields: JsonObject;
    if (message.type === "user") {
      const content = record(message.message)?.content;
      if (!Array.isArray(content)) return;
      for (const block of this.records(content))
        if (block.type === "tool_result")
          this.edge(message, closing, {
            kind: "tool_result",
            toolUseId: this.id(block.tool_use_id),
            isError:
              block.is_error === undefined
                ? false
                : typeof block.is_error === "boolean"
                  ? block.is_error
                  : null,
          });
      return;
    }
    if (message.type === "result")
      fields = {
        kind: "result",
        ...this.result({
          resultId: message.uuid ?? null,
          subtype: message.subtype,
          isError: message.is_error,
          numTurns: message.num_turns ?? null,
          queuedTurns: message.queued_turn_count ?? null,
          stopReason: message.stop_reason ?? null,
        }),
      };
    else if (message.type === "assistant") {
      const tools = this.records(record(message.message)?.content).filter(
        (block) => block.type === "tool_use",
      );
      fields = {
        kind: "assistant",
        parentToolUseId: this.id(message.parent_tool_use_id),
        tools: tools
          .slice(0, MAX_IDS)
          .map((tool) => ({ id: this.id(tool.id), kind: toolKind(tool.name) })),
        toolsCount: tools.length,
        toolsOmitted: Math.max(0, tools.length - MAX_IDS),
      };
    } else if (message.type === "tool_progress")
      fields = {
        kind: "tool_progress",
        toolUseId: this.id(message.tool_use_id),
        taskId: this.id(message.task_id),
        parentToolUseId: this.id(message.parent_tool_use_id),
        toolKind: toolKind(message.tool_name),
      };
    else if (message.type === "system") {
      if (message.subtype === "status")
        fields = { kind: "status", status: allowed(message.status, ["requesting", "compacting"]) };
      else if (
        message.subtype === "task_started" ||
        message.subtype === "task_notification" ||
        message.subtype === "task_progress"
      ) {
        fields = {
          kind: message.subtype,
          taskId: this.id(message.task_id),
          toolUseId: this.id(message.tool_use_id),
        };
        if (message.subtype === "task_started") {
          fields.taskKind = taskKind(message.task_type);
          fields.ambient = message.ambient === true;
        }
        if (message.subtype === "task_notification")
          fields.status = allowed(message.status, ["completed", "failed", "stopped"]);
      } else if (message.subtype === "background_tasks_changed") {
        const tasks = this.records(message.tasks);
        fields = {
          kind: "inventory",
          count: Array.isArray(message.tasks) ? message.tasks.length : 0,
          omitted: Math.max(0, tasks.length - MAX_IDS),
          tasks: tasks.slice(0, MAX_IDS).map((task) => ({
            taskId: this.id(task.task_id),
            taskKind: taskKind(task.task_type),
            ambient: task.ambient === true,
          })),
        };
      } else if (message.subtype === "hook_started" || message.subtype === "hook_response") {
        fields = { kind: message.subtype, hookId: this.id(message.hook_id) };
        if (message.subtype === "hook_response")
          fields.status = allowed(message.outcome, ["success", "error", "cancelled"]);
      } else return;
    } else return;
    this.edge(message, closing, fields);
  }
  private edge(message: SDKMessage, closing: boolean, fields: JsonObject): void {
    this.edges.push({
      seq: ++this.seq,
      closing,
      messageId: this.id(message.uuid),
      nativeSessionId: this.id(message.session_id),
      ...fields,
    });
    while (this.edges.length > MAX_ENTRIES || bytes(this.edges) > MAX_EDGE_BYTES) {
      this.edges.shift();
      this.droppedEdges++;
    }
  }
  snapshot(): {
    initialClose: JsonObject | null;
    edges: JsonObject[];
    droppedEdges: number;
    truncatedFields: number;
  } {
    const snapshot = {
      initialClose: this.initialClose,
      edges: [...this.edges],
      droppedEdges: this.droppedEdges,
      truncatedFields: this.truncatedFields,
    };
    while (bytes(snapshot) > MAX_BYTES && snapshot.edges.length > 0) {
      snapshot.edges.shift();
      snapshot.droppedEdges++;
    }
    return snapshot;
  }
}
