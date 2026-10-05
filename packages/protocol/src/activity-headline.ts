import { type Static, Type } from "typebox";
import { capHeadline } from "./headline.ts";
import type { ContentBlock, HistoryRecord } from "./history.ts";
import { ToolResultContext } from "./tool-result-context.ts";

export const ActivityHeadlineResponseSchema = Type.Object(
  { headline: Type.String() },
  { additionalProperties: false },
);
export type ActivityHeadlineResponse = Static<typeof ActivityHeadlineResponseSchema>;
export interface ActivityHeadlineSource {
  kind: "intent" | "outcome";
  tool: string;
  text: string;
}

type Call = Extract<ContentBlock, { type: "tool_call" }>;
/** Causal matching state retains only IDs and tool names, never call/result bodies. */
export class ActivityHeadlineContext {
  private readonly context = new ToolResultContext<string>();

  visit(record: HistoryRecord): Map<number, string> {
    return this.context.visit(record, (source, index) => {
      const block = source.type === "message" ? source.content[index] : undefined;
      return block?.type === "tool_call" ? block.name : "";
    });
  }
}

/** Bound the quoted JSON itself, including escaping, without splitting Unicode. */
function quoted(fields: Record<string, string | boolean>): string {
  const selected: Record<string, string | boolean> = {};
  let remaining =
    8192 -
    new TextEncoder().encode(
      JSON.stringify(fields, (_key, value) => (typeof value === "string" ? "" : value)),
    ).length;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      selected[key] = value;
      continue;
    }
    const chunks: string[] = [];
    for (const char of value) {
      const size = new TextEncoder().encode(JSON.stringify(char)).length - 2;
      if (size > remaining) break;
      chunks.push(char);
      remaining -= size;
    }
    selected[key] = chunks.join("");
  }
  return JSON.stringify(selected);
}

/** Public root code only, preserving whitespace within the existing header byte bound. */
export function activityCallCode(name: string, args: unknown): string | undefined {
  if (name !== "codemode" && name !== "bash") return undefined;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[name === "bash" ? "command" : "code"];
  return typeof value === "string" && value.trim() !== "" ? capHeadline(value) : undefined;
}

export function activityCallEligible(block: Call): boolean {
  return (
    activityCallCode(block.name, block.arguments) !== undefined ||
    block.name === "subagent" ||
    block.name === "get_subagent_result" ||
    (block.name === "steer_subagent" &&
      typeof block.arguments === "object" &&
      block.arguments !== null &&
      !Array.isArray(block.arguments) &&
      typeof block.arguments.message === "string" &&
      block.arguments.message.trim() !== "")
  );
}
export function activityResultEligible(
  block: Extract<ContentBlock, { type: "tool_result" }>,
  tool: string | undefined,
): boolean {
  if (tool === "bash" || tool === "get_subagent_result") return true;
  return (
    tool === "subagent" &&
    !block.content.some(
      (child) =>
        child.type === "text" &&
        /^Agent (?:queued|started) in background\./.test(
          child.text.match(
            /^Agent (?:(?:queued|started) in background\.|completed in |failed:)/m,
          )?.[0] ?? "",
        ),
    )
  );
}

/** Select immutable normalized data only; native overflow and nested child transcripts are never read. */
export function getActivityHeadlineSource(
  records: readonly HistoryRecord[],
  recordId: string,
  detailKey: string,
): ActivityHeadlineSource | null {
  const context = new ActivityHeadlineContext();
  for (const record of records) {
    const matches = context.visit(record);
    if (record.id !== recordId) continue;
    if (
      record.type === "event" &&
      detailKey === `${record.id}:subagent` &&
      record.subagent?.kind === "notification"
    ) {
      const notice = record.subagent;
      return {
        kind: "outcome",
        tool: "subagent",
        text: quoted({
          status: notice.status ?? "",
          ...(notice.error ? { error: notice.error } : { result: notice.resultPreview ?? "" }),
          description: notice.description ?? "",
        }),
      };
    }
    if (record.type !== "message" || record.role === "user") return null;
    const index = record.content.findIndex(
      (_block, index) => detailKey === `${record.id}:${index}`,
    );
    const block = record.content[index];
    if (block?.type === "tool_call" && activityCallEligible(block)) {
      const args = block.arguments;
      const fields = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
      const string = (key: string) =>
        typeof fields[key] === "string" ? (fields[key] as string) : "";
      return {
        kind: "intent",
        tool: block.name,
        text: quoted(
          block.name === "codemode"
            ? { code: string("code") }
            : block.name === "bash"
              ? { command: string("command") }
              : block.name === "steer_subagent"
                ? {
                    ...(typeof fields.agent_id === "string" ? { agent_id: fields.agent_id } : {}),
                    message: string("message"),
                  }
                : block.name === "get_subagent_result"
                  ? {
                      agent_id: string("agent_id"),
                      ...(typeof fields.wait === "boolean" ? { wait: fields.wait } : {}),
                      ...(typeof fields.verbose === "boolean" ? { verbose: fields.verbose } : {}),
                    }
                  : { description: string("description"), prompt: string("prompt") },
        ),
      };
    }
    if (block?.type === "tool_result" && activityResultEligible(block, matches.get(index))) {
      return {
        kind: "outcome",
        tool: matches.get(index)!,
        text: quoted({
          isError: block.isError ?? false,
          text: block.content
            .filter((child) => child.type === "text")
            .map((child) => child.text.split("\n\n--- Agent Conversation ---\n")[0] ?? "")
            .join("\n"),
        }),
      };
    }
    return null;
  }
  return null;
}
