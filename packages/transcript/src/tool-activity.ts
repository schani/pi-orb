import type { ContentBlock, JsonValue } from "@pi-orb/protocol";

export type ToolCallBlock = ContentBlock & { type: "tool_call" };
export type ToolResultBlock = ContentBlock & { type: "tool_result" };

export interface PersistedToolCall {
  call: ToolCallBlock;
  result?: ToolResultBlock;
}

export interface LiveToolCall {
  callId: string;
  name: string;
  state: "running" | "completed" | "failed";
}

export type CallState = "running" | "completed" | "failed";

export interface ActivityCall {
  callId: string;
  name: string;
  arguments: JsonValue | null;
  result?: ToolResultBlock;
  state: CallState;
}

export type CategoryKind = "edit" | "command" | "read" | "other";

export interface ActivityCategory {
  key: string;
  kind: CategoryKind;
  label: string;
  calls: ActivityCall[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

function objectValue(value: JsonValue | null): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function stringArgument(call: ActivityCall, key: string): string | null {
  const value = objectValue(call.arguments)?.[key];
  return typeof value === "string" ? value : null;
}

function numberArgument(call: ActivityCall, key: string): number | null {
  const value = objectValue(call.arguments)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function callPath(call: ActivityCall): string | null {
  return stringArgument(call, "path");
}

function readCallLabel(call: ActivityCall): string {
  const path = callPath(call) ?? call.name;
  const offset = numberArgument(call, "offset");
  const limit = numberArgument(call, "limit");
  if (offset === null && limit === null) return path;
  const start = offset ?? 1;
  return limit === null ? `${path}:${start}+` : `${path}:${start}–${start + limit - 1}`;
}

/** How a single call names itself inside its category. */
export function callLabel(call: ActivityCall, kind: CategoryKind): string {
  switch (kind) {
    case "read":
      return readCallLabel(call);
    case "edit":
      return callPath(call) ?? call.name;
    case "command":
      return stringArgument(call, "command") ?? call.name;
    case "other":
      return call.name;
  }
}

export function resultText(result: ToolResultBlock | undefined): string {
  if (result === undefined) return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function patchStats(patch: string | null): DiffStats | null {
  if (patch === null) return null;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function statsForCalls(calls: readonly ActivityCall[]): DiffStats | null {
  let found = false;
  let added = 0;
  let removed = 0;
  for (const call of calls) {
    const stats = patchStats(call.result?.patch ?? null);
    if (stats === null) continue;
    found = true;
    added += stats.added;
    removed += stats.removed;
  }
  return found ? { added, removed } : null;
}

function categoryFor(name: string): { key: string; kind: CategoryKind; label: string } {
  switch (name) {
    case "edit":
    case "write":
      return { key: "edit", kind: "edit", label: "edit" };
    case "bash":
      return { key: "command", kind: "command", label: "commands" };
    case "read":
      return { key: "read", kind: "read", label: "read" };
    default:
      return { key: `other:${name}`, kind: "other", label: name };
  }
}

/** Persisted calls keep their history order; live chips follow them. */
export function activityCalls(
  persisted: readonly PersistedToolCall[],
  live: readonly LiveToolCall[],
): ActivityCall[] {
  return [
    ...persisted.map(({ call, result }) => ({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      ...(result !== undefined ? { result } : {}),
      state:
        result === undefined
          ? ("running" as const)
          : result.isError === true
            ? ("failed" as const)
            : ("completed" as const),
    })),
    ...live.map((call) => ({ ...call, arguments: null })),
  ];
}

export function categorize(calls: readonly ActivityCall[]): ActivityCategory[] {
  const categories = new Map<string, ActivityCategory>();
  for (const call of calls) {
    const descriptor = categoryFor(call.name);
    const existing = categories.get(descriptor.key);
    if (existing !== undefined) {
      existing.calls.push(call);
    } else {
      categories.set(descriptor.key, { ...descriptor, calls: [call] });
    }
  }
  return [...categories.values()];
}

export function uniquePathCount(calls: readonly ActivityCall[]): number {
  const paths = new Set(calls.map(callPath).filter((path): path is string => path !== null));
  return paths.size > 0 ? paths.size : calls.length;
}

export function categoryState(category: ActivityCategory): CallState {
  if (category.calls.some((call) => call.state === "failed")) return "failed";
  if (category.calls.some((call) => call.state === "running")) return "running";
  return "completed";
}

/** A category of one names its file or command; larger runs count in the metric. */
export function categoryHeadline(category: ActivityCategory): string | null {
  const firstCall = category.calls[0];
  if (firstCall === undefined) return null;
  switch (category.kind) {
    case "edit":
      return category.calls.length === 1 ? callPath(firstCall) : null;
    case "command":
      return category.calls.length === 1 ? stringArgument(firstCall, "command") : null;
    case "read":
      return uniquePathCount(category.calls) === 1 ? callPath(firstCall) : null;
    case "other":
      return null;
  }
}

export type CategoryCount =
  | { kind: "diff"; added: number; removed: number }
  | { kind: "count"; label: string }
  | null;

export function categoryCount(category: ActivityCategory): CategoryCount {
  if (category.kind === "edit") {
    const stats = statsForCalls(category.calls);
    if (stats !== null) return { kind: "diff", added: stats.added, removed: stats.removed };
  }
  const count =
    category.kind === "edit" || category.kind === "read"
      ? uniquePathCount(category.calls)
      : category.calls.length;
  if (count < 2) return null;
  if (category.kind === "command") return { kind: "count", label: `${count} ran` };
  return {
    kind: "count",
    label: `${count} ${category.kind === "other" ? "calls" : "files"}`,
  };
}

export type CategoryProgress = { kind: "failed"; count: number } | { kind: "running" } | null;

export function categoryProgress(category: ActivityCategory): CategoryProgress {
  const failures = category.calls.filter((call) => call.state === "failed").length;
  if (failures > 0) return { kind: "failed", count: failures };
  return category.calls.some((call) => call.state === "running") ? { kind: "running" } : null;
}

export function callStatus(call: ActivityCall): string {
  if (call.state === "failed") return "failed";
  if (call.state === "running") return "running";
  return "complete";
}
