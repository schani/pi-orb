import {
  type ActivityCall,
  type ActivityCategory,
  activityCalls,
  type CategoryCount,
  callLabel,
  callStatus,
  categorize,
  categoryCount,
  categoryHeadline,
  categoryProgress,
  categoryState,
  type LiveToolCall,
  type PersistedToolCall,
  patchStats,
  resultText,
} from "@pi-orb/transcript";
import type { ReactNode } from "react";
import { ActivityRailRow } from "./ActivityRailRow.tsx";

interface ToolActivityProps {
  persisted?: readonly PersistedToolCall[];
  live?: readonly LiveToolCall[];
}

function renderCount(count: CategoryCount): ReactNode | null {
  if (count === null) return null;
  if (count.kind === "count") return count.label;
  return (
    <>
      <span className="tool-diff-added">+{count.added}</span>{" "}
      <span className="tool-diff-removed">−{count.removed}</span>
    </>
  );
}

function categoryMetric(category: ActivityCategory): ReactNode | undefined {
  const lead = renderCount(categoryCount(category));
  const progress = categoryProgress(category);
  const trail =
    progress === null ? null : progress.kind === "failed" ? (
      <span className="tool-activity-failed">{progress.count} failed</span>
    ) : (
      <span className="tool-activity-running">running</span>
    );
  if (lead === null) return trail ?? undefined;
  if (trail === null) return lead;
  return (
    <>
      {lead}
      {" · "}
      {trail}
    </>
  );
}

function CommandCall({ call }: { call: ActivityCall }) {
  const output = resultText(call.result);
  return (
    <div className="tool-command">
      <div className="tool-command-line">
        <span className="rec-px">run</span>
        <span className="tool-command-text">{callLabel(call, "command")}</span>
      </div>
      {output !== "" && <pre className="tool-command-output">{output}</pre>}
      <div className="tool-command-footer">
        <span
          className={
            call.state === "failed"
              ? "tool-activity-failed"
              : call.state === "running"
                ? "tool-activity-running"
                : undefined
          }
        >
          {call.state === "failed"
            ? "✕ failed"
            : call.state === "running"
              ? "◐ running"
              : "✓ completed"}
        </span>
      </div>
    </div>
  );
}

function FileCall({ call, kind }: { call: ActivityCall; kind: "edit" | "read" }) {
  const path = callLabel(call, kind);
  const output = resultText(call.result);
  const stats = kind === "edit" ? patchStats(call.result?.patch ?? null) : null;
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
        <span className="tool-call-marker">·</span>
        <code className="trunc">{path}</code>
        {metric !== null && (
          <span className={`tool-call-status tool-call-${call.state}`}>{metric}</span>
        )}
      </div>
    );
  }
  return (
    <details className="tool-activity-call">
      <summary>
        <span className="tool-call-marker">·</span>
        <code className="trunc">{path}</code>
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

function OtherCall({ call, single }: { call: ActivityCall; single: boolean }) {
  const input = call.arguments === null ? "" : JSON.stringify(call.arguments, null, 2);
  const output = resultText(call.result);
  const detail = (
    <pre
      className={
        call.state === "failed" ? "tool-call-output tool-call-output-error" : "tool-call-output"
      }
    >
      {[input, output].filter(Boolean).join("\n\n") || "(no details)"}
    </pre>
  );
  if (single) return detail;
  return (
    <details className="tool-activity-call">
      <summary>
        <span className="tool-call-marker">·</span>
        <code className="trunc">{callLabel(call, "other")}</code>
        <span className={`tool-call-status tool-call-${call.state}`}>{callStatus(call)}</span>
      </summary>
      {detail}
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
        return <OtherCall call={call} single={category.calls.length === 1} key={call.callId} />;
      })}
    </div>
  );
}

export function ToolActivity({ persisted = [], live = [] }: ToolActivityProps) {
  const calls = activityCalls(persisted, live);
  if (calls.length === 0) return null;
  return (
    <div className="tool-activity">
      {categorize(calls).map((category) => (
        <ActivityRailRow
          className="tool-activity-category"
          headline={categoryHeadline(category) ?? undefined}
          key={category.key}
          label={category.label}
          metric={categoryMetric(category)}
          state={categoryState(category)}
        >
          <CategoryCalls category={category} />
        </ActivityRailRow>
      ))}
    </div>
  );
}
