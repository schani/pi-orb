// Adapted from Pi 1.0.0; see PROVENANCE.md and LICENSE.
import type { CodemodeResult } from "@earendil-works/pi-codemode";
export interface NestedCall {
  id: string;
  name: string;
  args?: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  executionWait?: boolean;
  progress?: number;
  total?: number;
  diagnostics?: { code: string; severity: string }[];
}
/** Default token budget for script output. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating. */
const CHARS_PER_TOKEN = 4;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function formatCallSummary(calls: readonly NestedCall[]): string {
  if (calls.length === 0) return "No tool calls were made.";
  return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

export function formatError(
  result: Extract<CodemodeResult, { ok: false }>,
  calls: readonly NestedCall[],
): string {
  const { error } = result;
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  return `${head}\n\n${formatCallSummary(calls)}`;
}
