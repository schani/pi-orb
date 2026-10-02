import type { DisplayRecord } from "@pi-orb/protocol";
import { useState } from "react";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { PlainChatText } from "./ChatText.tsx";
import { CommittedBody, type DetailContext } from "./DetailBody.tsx";

function text(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== "" ? value : null;
}

/** Root receipt fields only: never load or link a private child session. */
type DisplayEvent = Extract<DisplayRecord, { type: "event" }>;
export function SubagentNotice({
  record,
  detailContext,
}: {
  record: DisplayEvent;
  detailContext: DetailContext;
}) {
  const [open, setOpen] = useState(false);
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
  return (
    <ActivityRailRow
      label={description}
      metric={status}
      state={failed ? "failed" : "neutral"}
      className="subagent-notice"
      onToggle={setOpen}
    >
      {open && (
        <CommittedBody
          context={detailContext}
          recordId={record.id}
          detailKey={notice.detailKey}
          render={(body) =>
            body.type === "subagent" ? (
              <div className={`subagent-notice-body${failed ? " tool-call-output-error" : ""}`}>
                <PlainChatText>
                  {notice.kind === "update"
                    ? (text(body.message) ?? "Notification details unavailable.")
                    : notice.kind === "workspace_notice"
                      ? (text(body.notice) ?? "Notification details unavailable.")
                      : (text(body.error) ??
                        text(body.resultPreview) ??
                        "Notification details unavailable.")}
                </PlainChatText>
                {body.durationMs !== undefined && body.durationMs >= 0 && (
                  <div className="subagent-duration">{(body.durationMs / 1000).toFixed(1)}s</div>
                )}
              </div>
            ) : null
          }
        />
      )}
    </ActivityRailRow>
  );
}

export function isSubagentNotice(record: Pick<DisplayEvent, "subagent">): boolean {
  return record.subagent !== undefined;
}
