import type { ContentBlock, JsonValue, MessageRecord } from "@pi-orb/protocol";
import type { ReactNode } from "react";
import { ActivityRailRow } from "./ActivityRailRow.tsx";

export type ToolCallBlock = ContentBlock & { type: "tool_call" };
export type ToolResultBlock = ContentBlock & { type: "tool_result" };

export interface PersistedToolCall {
  call: ToolCallBlock;
  result?: ToolResultBlock;
  resultRecord?: MessageRecord;
}

export interface LiveToolCall {
  callId: string;
  name: string;
  state: "running" | "completed" | "failed";
}

interface ToolActivityProps {
  persisted?: readonly PersistedToolCall[];
  live?: readonly LiveToolCall[];
}

type ActivityCall = {
  callId: string;
  name: string;
  arguments: JsonValue | null;
  result?: ToolResultBlock;
  resultRecord?: MessageRecord;
  state: "running" | "completed" | "failed";
};

type CategoryKind = "edit" | "command" | "read" | "other";

interface ActivityCategory {
  key: string;
  kind: CategoryKind;
  label: string;
  calls: ActivityCall[];
}

interface DiffStats {
  added: number;
  removed: number;
}

function objectValue(value: JsonValue | null): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringArgument(call: ActivityCall, key: string): string | null {
  const value = objectValue(call.arguments)?.[key];
  return typeof value === "string" ? value : null;
}

function numberArgument(call: ActivityCall, key: string): number | null {
  const value = objectValue(call.arguments)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function callPath(call: ActivityCall): string | null {
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

function resultText(result: ToolResultBlock | undefined): string {
  if (result === undefined) return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function nativePatch(call: ActivityCall): string | null {
  const native = call.resultRecord?.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return null;
  const message = native["message"];
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const details = message["details"];
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  return typeof details["patch"] === "string" ? details["patch"] : null;
}

function patchStats(patch: string | null): DiffStats | null {
  if (patch === null) return null;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function statsForCalls(calls: readonly ActivityCall[]): DiffStats | null {
  let found = false;
  let added = 0;
  let removed = 0;
  for (const call of calls) {
    const stats = patchStats(nativePatch(call));
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
      return { key: "edit", kind: "edit", label: "Edit" };
    case "bash":
      return { key: "command", kind: "command", label: "Command" };
    case "read":
      return { key: "read", kind: "read", label: "Read" };
    default:
      return { key: `other:${name}`, kind: "other", label: name };
  }
}

function categorize(calls: readonly ActivityCall[]): ActivityCategory[] {
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

function uniquePathCount(calls: readonly ActivityCall[]): number {
  const paths = new Set(calls.map(callPath).filter((path): path is string => path !== null));
  return paths.size > 0 ? paths.size : calls.length;
}

function categoryState(category: ActivityCategory): "running" | "completed" | "failed" {
  if (category.calls.some((call) => call.state === "failed")) return "failed";
  if (category.calls.some((call) => call.state === "running")) return "running";
  return "completed";
}

function categoryHeadline(category: ActivityCategory): string {
  const count =
    category.kind === "edit" || category.kind === "read"
      ? uniquePathCount(category.calls)
      : category.calls.length;
  const onlyCall = category.calls.length === 1 ? category.calls[0] : undefined;
  switch (category.kind) {
    case "edit":
      return onlyCall === undefined
        ? `${count} ${count === 1 ? "file" : "files"} changed`
        : (callPath(onlyCall) ?? "1 file changed");
    case "command":
      return onlyCall === undefined
        ? `${count} commands ran`
        : (stringArgument(onlyCall, "command") ?? "1 command ran");
    case "read": {
      const firstCall = category.calls[0];
      if (count === 1 && firstCall !== undefined) return callPath(firstCall) ?? "1 file";
      return `${count} files read`;
    }
    case "other":
      return `${count} ${count === 1 ? "call" : "calls"}`;
  }
}

function categoryMetric(category: ActivityCategory): ReactNode {
  const state = categoryState(category);
  if (category.kind === "edit") {
    const stats = statsForCalls(category.calls);
    if (stats !== null) {
      return (
        <>
          <span className="tool-diff-added">+{stats.added}</span>{" "}
          <span className="tool-diff-removed">−{stats.removed}</span>
        </>
      );
    }
  }
  if (state === "failed") {
    const failures = category.calls.filter((call) => call.state === "failed").length;
    return <span className="tool-activity-failed">{failures} failed</span>;
  }
  if (state === "running") return <span className="tool-activity-running">running</span>;
  return "complete";
}

function callStatus(call: ActivityCall): string {
  if (call.state === "failed") return "failed";
  if (call.state === "running") return "running";
  return "complete";
}

function CommandCall({ call }: { call: ActivityCall }) {
  const command = stringArgument(call, "command") ?? call.name;
  const output = resultText(call.result);
  const canExpand = call.result !== undefined;
  if (!canExpand) {
    return (
      <div className="tool-activity-call tool-activity-command-call">
        <span className="tool-call-chevron">›</span>
        <code>{command}</code>
        <span className={`tool-call-status tool-call-${call.state}`}>{callStatus(call)}</span>
      </div>
    );
  }
  return (
    <details className="tool-activity-call tool-activity-command-call">
      <summary>
        <span className="tool-call-chevron">›</span>
        <code>{command}</code>
        <span className={`tool-call-status tool-call-${call.state}`}>{callStatus(call)}</span>
      </summary>
      <pre
        className={
          call.state === "failed" ? "tool-call-output tool-call-output-error" : "tool-call-output"
        }
      >
        {output === "" ? "(no output)" : output}
      </pre>
    </details>
  );
}

function FileCall({ call, kind }: { call: ActivityCall; kind: "edit" | "read" }) {
  const path = kind === "read" ? readCallLabel(call) : (callPath(call) ?? call.name);
  const output = resultText(call.result);
  const stats = kind === "edit" ? patchStats(nativePatch(call)) : null;
  const input = call.arguments === null ? "" : JSON.stringify(call.arguments, null, 2);
  const detail = output !== "" ? output : input;
  const metric =
    kind === "read" ? null : stats === null ? (
      callStatus(call)
    ) : (
      <>
        <span className="tool-diff-added">+{stats.added}</span>{" "}
        <span className="tool-diff-removed">−{stats.removed}</span>
      </>
    );
  if (detail === "") {
    return (
      <div className="tool-activity-call">
        <span className="tool-call-chevron">›</span>
        <code>{path}</code>
        {metric !== null && (
          <span className={`tool-call-status tool-call-${call.state}`}>{metric}</span>
        )}
      </div>
    );
  }
  return (
    <details className="tool-activity-call">
      <summary>
        <span className="tool-call-chevron">›</span>
        <code>{path}</code>
        {metric !== null && (
          <span className={`tool-call-status tool-call-${call.state}`}>{metric}</span>
        )}
      </summary>
      <pre
        className={
          call.state === "failed" ? "tool-call-output tool-call-output-error" : "tool-call-output"
        }
      >
        {detail}
      </pre>
    </details>
  );
}

function OtherCall({ call }: { call: ActivityCall }) {
  const input = call.arguments === null ? "" : JSON.stringify(call.arguments, null, 2);
  const output = resultText(call.result);
  return (
    <details className="tool-activity-call">
      <summary>
        <span className="tool-call-chevron">›</span>
        <code>{call.name}</code>
        <span className={`tool-call-status tool-call-${call.state}`}>{callStatus(call)}</span>
      </summary>
      <pre
        className={
          call.state === "failed" ? "tool-call-output tool-call-output-error" : "tool-call-output"
        }
      >
        {[input, output].filter(Boolean).join("\n\n") || "(no details)"}
      </pre>
    </details>
  );
}

function CategoryCalls({ category }: { category: ActivityCategory }) {
  return (
    <div className="tool-activity-calls">
      {category.calls.map((call) => {
        if (category.kind === "command") return <CommandCall call={call} key={call.callId} />;
        if (category.kind === "edit" || category.kind === "read") {
          return <FileCall call={call} kind={category.kind} key={call.callId} />;
        }
        return <OtherCall call={call} key={call.callId} />;
      })}
    </div>
  );
}

export function ToolActivity({ persisted = [], live = [] }: ToolActivityProps) {
  const calls: ActivityCall[] = [
    ...persisted.map(({ call, result, resultRecord }) => ({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      ...(result !== undefined ? { result } : {}),
      ...(resultRecord !== undefined ? { resultRecord } : {}),
      state:
        result === undefined
          ? ("running" as const)
          : result.isError === true
            ? ("failed" as const)
            : ("completed" as const),
    })),
    ...live.map((call) => ({ ...call, arguments: null })),
  ];
  if (calls.length === 0) return null;
  return (
    <div className="tool-activity">
      {categorize(calls).map((category) => {
        const state = categoryState(category);
        return (
          <ActivityRailRow
            className="tool-activity-category"
            headline={categoryHeadline(category)}
            key={category.key}
            label={category.label}
            metric={categoryMetric(category)}
            state={state}
          >
            <CategoryCalls category={category} />
          </ActivityRailRow>
        );
      })}
    </div>
  );
}
