import { type Static, Type } from "typebox";
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

export function activityCallEligible(block: Call): boolean {
  return block.name === "codemode" || block.name === "subagent";
}
export function activityResultEligible(
  block: Extract<ContentBlock, { type: "tool_result" }>,
  tool: string | undefined,
): boolean {
  if (tool === "get_subagent_result") return true;
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
