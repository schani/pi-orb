import type { EventRecord } from "@pi-orb/protocol";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { PlainChatText } from "./ChatText.tsx";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Root custom-message details only: never load or link a private child session. */
export function SubagentNotice({ record }: { record: EventRecord }) {
  const native = object(record.overflow["native"]);
  const kind = native?.["customType"];
  if (
    !["subagent-notification", "subagent-update", "subagent-workspace-notice"].includes(
      String(kind),
    )
  )
    return null;
  const details = object(native?.["details"]);
  const description = text(details?.["description"]) ?? "Subagent";
  const rawStatus = text(details?.["status"]);
  const failed = rawStatus === "error";
  const status =
    kind === "subagent-update"
      ? "update"
      : kind === "subagent-workspace-notice"
        ? "workspace"
        : failed
          ? "failed"
          : rawStatus === "steered"
            ? "completed (steered)"
            : (rawStatus ?? "notification");
  const body =
    kind === "subagent-update"
      ? text(details?.["message"])
      : kind === "subagent-workspace-notice"
        ? text(details?.["notice"])
        : (text(details?.["error"]) ?? text(details?.["resultPreview"]));
  const duration = details?.["durationMs"];
  const id = text(details?.["id"]);
  return (
    <ActivityRailRow
      label={description}
      metric={status}
      state={failed ? "failed" : "neutral"}
      className="subagent-notice"
    >
      <div className={`subagent-notice-body${failed ? " tool-call-output-error" : ""}`}>
        <PlainChatText>{body ?? "Notification details unavailable."}</PlainChatText>
        {(id !== null || typeof duration === "number") && (
          <div className="subagent-identity">
            {id}
            {id !== null && typeof duration === "number" ? " · " : ""}
            {typeof duration === "number" && Number.isFinite(duration) && duration >= 0
              ? `${(duration / 1000).toFixed(1)}s`
              : ""}
          </div>
        )}
      </div>
    </ActivityRailRow>
  );
}

export function isSubagentNotice(record: EventRecord): boolean {
  const kind = object(record.overflow["native"])?.["customType"];
  return (
    kind === "subagent-notification" ||
    kind === "subagent-update" ||
    kind === "subagent-workspace-notice"
  );
}
