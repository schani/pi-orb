import type { HistoryRecord } from "@pi-orb/protocol";

export function committedToolOutput(records: readonly HistoryRecord[], text: string): boolean {
  return records.some(
    (record) =>
      record.type === "message" &&
      record.role === "tool" &&
      record.content.some(
        (block) =>
          block.type === "tool_result" &&
          block.isError !== true &&
          block.content.some((leaf) => leaf.type === "text" && leaf.text.includes(text)),
      ),
  );
}

export interface BrowserFrame {
  direction: string;
  payload: string;
}

export function lifecycleEdge(
  logs: readonly string[],
  orb: string,
  event: string,
  fields: Readonly<Record<string, string>> = {},
): Record<string, string> | undefined {
  for (const line of logs.join("").split("\n").slice(0, -1)) {
    const marker = `lifecycle: orb=${orb} ${event} `;
    const start = line.indexOf(marker);
    if (start < 0) continue;
    const facts = Object.fromEntries(
      [...line.slice(start + marker.length).matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g)].map(
        ([, key, value]) => [
          key!,
          value!.startsWith('"') ? (JSON.parse(value!) as string) : value!,
        ],
      ),
    );
    if (Object.entries(fields).every(([key, value]) => facts[key] === value)) return facts;
  }
  return undefined;
}

export function summaryOutcome(logs: readonly string[], orb: string, operationId: string) {
  if (lifecycleEdge(logs, orb, "harness.summary_failed", { operationId })) return "failed";
  if (lifecycleEdge(logs, orb, "harness.summary_completed", { operationId })) return "completed";
  return "pending";
}

export function operationEvent(
  frames: readonly BrowserFrame[],
  operationId: string | undefined,
  type: string,
  fields: Readonly<Record<string, string>> = {},
): Record<string, unknown> | undefined {
  for (const frame of frames) {
    if (frame.direction !== "received") continue;
    const parsed = JSON.parse(frame.payload) as { type?: string; event?: Record<string, unknown> };
    const event = parsed.type === "runtime.event" ? parsed.event : undefined;
    if (
      event?.["type"] !== type ||
      (operationId !== undefined && event["operationId"] !== operationId)
    )
      continue;
    if (Object.entries(fields).every(([key, value]) => event[key] === value)) return event;
  }
  return undefined;
}
