import type { SimulationTask } from "determined";

/**
 * The marker every app-level lifecycle line carries (docs/lifecycle.md). One
 * grep for it in Cloud Logging returns the complete reconciliation history of
 * the fleet — and a healthy fleet produces none of these lines at all: only
 * state changes, decisions, and failures are logged, never steady state.
 */
export const LIFECYCLE_LOG_PREFIX = "lifecycle:";

export type LogFieldValue = string | number | boolean | null | undefined;

type LogFields = Readonly<Record<string, LogFieldValue>>;

/** Bare tokens stay unquoted; anything else is JSON-quoted so `key=value` parsing survives. */
function formatValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function format(event: string, fields: LogFields, subject?: string): string {
  const parts = [LIFECYCLE_LOG_PREFIX];
  if (subject !== undefined) parts.push(subject);
  parts.push(event);
  for (const [key, value] of Object.entries(fields)) {
    // Absent facts are omitted rather than logged as "null" noise.
    if (value === null || value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

/**
 * One grep-friendly line per orb-scoped decision:
 * `lifecycle: orb=<id> <event> key=value ...`.
 */
export function logOrbEvent(
  task: SimulationTask,
  orbId: string,
  event: string,
  fields: LogFields = {},
): void {
  task.log(format(event, fields, `orb=${orbId}`));
}

/** One grep-friendly line per project-scoped lifecycle decision. */
export function logProjectEvent(
  task: SimulationTask,
  projectId: string,
  event: string,
  fields: LogFields = {},
): void {
  task.log(format(event, fields, `project=${projectId}`));
}

/** The same line shape for events that belong to a loop rather than to one orb. */
export function logEvent(task: SimulationTask, event: string, fields: LogFields = {}): void {
  task.log(format(event, fields));
}
