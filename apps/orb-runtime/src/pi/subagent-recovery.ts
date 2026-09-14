import type { SubagentRun } from "../domain/subagent-work.ts";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Full root history, not compacted context and not child transcript files. */
export function interruptedSubagents(entries: readonly unknown[]): readonly SubagentRun[] {
  const pending = new Map<string, SubagentRun>();
  for (const raw of entries) {
    const entry = object(raw);
    if (!entry) continue;
    const data = object(entry["data"]);
    if (entry["type"] === "custom" && entry["customType"] === "pi-orb.subagent-run" && data) {
      const childId = data["childId"],
        operationId = data["operationId"];
      if (typeof childId !== "string" || typeof operationId !== "string") continue;
      if (data["phase"] === "admitted") pending.set(childId, { childId, operationId });
      else if (data["phase"] === "terminal" && pending.get(childId)?.operationId === operationId)
        pending.delete(childId);
    } else if (
      entry["type"] === "custom" &&
      entry["customType"] === "subagents:record" &&
      typeof data?.["id"] === "string"
    ) {
      pending.delete(data["id"]);
    } else if (
      entry["type"] === "custom_message" &&
      ["pi-orb.host-restarted", "pi-orb.turn-resume", "pi-orb.turn-resume-declined"].includes(
        String(entry["customType"]),
      )
    ) {
      const runs = object(entry["details"])?.["interruptedSubagents"];
      if (!Array.isArray(runs)) continue;
      for (const value of runs) {
        const run = object(value);
        if (
          typeof run?.["childId"] === "string" &&
          pending.get(run["childId"])?.operationId === run["operationId"]
        )
          pending.delete(run["childId"]);
      }
    }
  }
  return [...pending.values()];
}
