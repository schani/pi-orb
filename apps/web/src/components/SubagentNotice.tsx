import type { EventRecord } from "@pi-orb/protocol";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { PlainChatText } from "./ChatText.tsx";

function text(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== "" ? value : null;
}

/** Root receipt fields only: never load or link a private child session. */
export function SubagentNotice({ record }: { record: EventRecord }) {
  const notice = record.subagent;
  if (notice === undefined) return null;
  const description = text(notice.description) ?? "Subagent";
  const failed = notice.status === "error";
  const status =
    notice.kind === "update"
      ? "update"
      : notice.kind === "workspace_notice"
        ? "workspace"
        : failed
          ? "failed"
          : notice.status === "steered"
            ? "completed (steered)"
            : (text(notice.status) ?? "notification");
  const body =
    notice.kind === "update"
      ? text(notice.message)
      : notice.kind === "workspace_notice"
        ? text(notice.notice)
        : (text(notice.error) ?? text(notice.resultPreview));
  const duration = notice.durationMs;
  const id = text(notice.id);
  return (
    <ActivityRailRow
      label={description}
      metric={status}
      state={failed ? "failed" : "neutral"}
      className="subagent-notice"
    >
      <div className={`subagent-notice-body${failed ? " tool-call-output-error" : ""}`}>
        <PlainChatText>{body ?? "Notification details unavailable."}</PlainChatText>
        {(id !== null || duration !== undefined) && (
          <div className="subagent-identity">
            {id}
            {id !== null && duration !== undefined ? " · " : ""}
            {duration !== undefined && Number.isFinite(duration) && duration >= 0
              ? `${(duration / 1000).toFixed(1)}s`
              : ""}
          </div>
        )}
      </div>
    </ActivityRailRow>
  );
}

export function isSubagentNotice(record: EventRecord): boolean {
  return record.subagent !== undefined;
}
