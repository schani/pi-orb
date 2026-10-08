import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Result, ResultAsync } from "neverthrow";
import { FailureEvidence, failureHistory, failureRequests } from "./failure-evidence.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const member = (value: unknown, values: string[]) =>
  values.includes(String(value)) ? value : null;
const uuid = (value: unknown) =>
  typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
    ? value
    : null;
const childId = (value: unknown) =>
  typeof value === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{3}$/i.test(value)
    ? value
    : uuid(value);
const entryId = (value: unknown) =>
  typeof value === "string" && /^[\da-f]{8}$/i.test(value) ? value : uuid(value);
const timestamp = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? value
    : null;
const unavailable = () => ({ unavailable: true });
const counter = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function streamMetadata(value: unknown) {
  const row = object(value);
  return {
    requestId: uuid(row["requestId"]),
    operationId: uuid(row["operationId"]),
    sessionId: uuid(row["sessionId"]),
    parentSessionId: uuid(row["parentSessionId"]),
    ...Object.fromEntries(
      [
        "attempt",
        "startedAt",
        "firstEventAt",
        "lastEventAt",
        "lastNormalizedAt",
        "events",
        "normalizedEvents",
        "normalizedToolArgumentEvents",
        "toolArgumentEvents",
        "textBytes",
        "reasoningBytes",
        "toolArgumentBytes",
        "httpResponses",
        "httpStatus",
      ].map((key) => [key, counter(row[key])]),
    ),
    lastEventType: member(row["lastEventType"], [
      "response.created",
      "response.in_progress",
      "response.completed",
      "response.done",
      "response.failed",
      "response.incomplete",
      "response.output_item.added",
      "response.output_item.done",
      "response.content_part.added",
      "response.content_part.done",
      "response.output_text.delta",
      "response.output_text.done",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_text.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "error",
    ]),
    phase: member(row["phase"], [
      "waiting",
      "streaming",
      "text",
      "reasoning",
      "tool_arguments",
      "terminal",
    ]),
    transport: member(row["transport"], ["unknown", "sse"]),
    issues: (Array.isArray(row["issues"]) ? row["issues"] : [])
      .filter((issue) => ["no_event_gap", "large_tool_arguments"].includes(issue))
      .slice(0, 2),
    edge: member(row["edge"], ["no_event_gap", "large_tool_arguments", "terminal"]),
    observedAt: counter(row["observedAt"]),
    terminal: member(row["terminal"], ["completed", "aborted", "failed"]),
  };
}

function rootMetadata(root: string, orb: string) {
  return Result.fromThrowable(() => {
    const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
    const file = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .at(-1);
    if (!file) return unavailable();
    const fd = openSync(join(directory, file), "r");
    let text: string;
    let truncated: boolean;
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - 65536);
      truncated = start > 0;
      const buffer = Buffer.alloc(Math.min(size, 65536));
      text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start)).toString();
      if (truncated) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
    const entries = text
      .split("\n")
      .filter(Boolean)
      .slice(-30)
      .map((line) => {
        const decoded = Result.fromThrowable(() => JSON.parse(line), unavailable)();
        if (decoded.isErr()) return { undecodable: true };
        const entry = object(decoded.value),
          message = object(entry["message"]),
          data = object(entry["data"]);
        return {
          type: member(entry["type"], [
            "session",
            "message",
            "custom",
            "custom_message",
            "compaction",
          ]),
          id: entryId(entry["id"]),
          parentId: entryId(entry["parentId"]),
          timestamp: timestamp(entry["timestamp"]),
          role: member(message["role"], ["user", "assistant", "toolResult", "custom"]),
          stopReason: member(message["stopReason"], [
            "stop",
            "length",
            "toolUse",
            "error",
            "aborted",
          ]),
          customType: member(entry["customType"] ?? message["customType"], [
            "pi-orb.subagent-run",
            "subagents:record",
            "subagent-notification",
            "subagent-update",
            "pi-orb.stream-audit",
          ]),
          ...(entry["customType"] === "pi-orb.stream-audit"
            ? { stream: streamMetadata(data) }
            : {}),
          phase: member(data["phase"], ["admitted", "started", "terminal", "wake_suppressed"]),
          childId: childId(data["childId"] ?? data["id"]),
          operationId: uuid(data["operationId"]),
          status: member(data["status"], ["running", "completed", "error", "cancelled", "stopped"]),
        };
      });
    return { truncated, entries };
  }, unavailable)().unwrapOr(unavailable());
}

function modelMetadata(value: unknown) {
  return failureRequests(value)
    .filter((row) => row.surface === "model")
    .slice(-30)
    .map((row) => {
      const eventCounts: Record<string, number> = {};
      for (const type of row.eventTypes)
        if (type !== null) eventCounts[type] = (eventCounts[type] ?? 0) + 1;
      return {
        id: row.id,
        status: row.status,
        matchedRuleIndex: row.matchedRuleIndex,
        createdAt: row.createdAt,
        stopReason: row.stopReason,
        aborted: row.aborted,
        finalized: row.finalized,
        eventCounts,
      };
    });
}

type Probe = "health" | "orb" | "history" | "model" | "names";
type EvidenceError = { type: "evidence_write_failed" };

export const readFailureJson = ResultAsync.fromThrowable(
  async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return {
      status: response.status,
      body: response.status === 200 ? ((await response.json()) as unknown) : {},
    };
  },
  (): { type: "probe_unavailable" } => ({ type: "probe_unavailable" }),
);

/** Failure-only projection: never persist raw logs, native contents or provider payloads. */
export async function captureSubagentFailure(options: {
  root: string;
  orb: string;
  phase: "continuation" | "abort" | "recovery" | "archive" | "profiles" | "setup";
  artifact: string;
  logs: string[];
  probes: Partial<Record<Probe, () => Promise<unknown>>>;
}) {
  const bundle = {
    orb: uuid(options.orb),
    phase: options.phase,
    capturedAt: new Date().toISOString(),
    root: rootMetadata(options.root, options.orb),
    lifecycle: options.logs
      .join("")
      .split("\n")
      .flatMap((line) => {
        const edge = line.match(/lifecycle: orb=([\da-f-]+) ([a-z-]+)/);
        return edge?.[1] === options.orb &&
          [
            "archive-waiting-for-work",
            "archive-history-sealed",
            "transition",
            "pull-failed",
            "reconcile-retry",
            "host-start",
            "host-stop",
            "session-rotated",
          ].includes(edge[2] ?? "")
          ? [edge[2]]
          : [];
      })
      .slice(-30),
    probes: {} as Partial<Record<Probe, unknown>>,
  };
  const save = ResultAsync.fromThrowable(
    async () => {
      await mkdir(dirname(options.artifact), { recursive: true });
      const temporary = `${options.artifact}.tmp`;
      await writeFile(temporary, JSON.stringify(bundle), { mode: 0o600 });
      await rename(temporary, options.artifact);
    },
    (): EvidenceError => ({ type: "evidence_write_failed" }),
  );
  const local = await save();
  if (local.isErr()) return local;
  // The local snapshot already survives an unavailable runtime/provider or subsequent cleanup.
  await Promise.all(
    Object.entries(options.probes).map(async ([key, probe]) => {
      const result = await ResultAsync.fromThrowable(probe, unavailable)();
      if (result.isErr()) {
        bundle.probes[key as Probe] = unavailable();
        return;
      }
      const value = result.value;
      if (object(value)["unavailable"] === true) {
        bundle.probes[key as Probe] = unavailable();
        return;
      }
      if (key === "model" || key === "names") {
        const response = object(value);
        bundle.probes[key] =
          response["status"] === 200 ? modelMetadata(response["body"]) : unavailable();
      } else if (key === "history") {
        const response = object(value),
          body = object(response["body"]);
        const code = response["status"];
        const status =
          typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599
            ? code
            : null;
        bundle.probes.history =
          status === 200 && Array.isArray(body["records"])
            ? { status, ...failureHistory(body) }
            : { status, unavailable: true };
      } else {
        const response = object(value),
          body = object(response["body"]);
        const evidence = new FailureEvidence(options.orb);
        await evidence.probe(key as "orb" | "health", async () => ({
          status: Number(response["status"]),
          body,
        }));
        bundle.probes[key as Probe] = {
          ...evidence.observations[0],
          activity: member(body["activity"], ["idle", "busy"]),
          operationId: uuid(body["operationId"]),
          ...(key === "health"
            ? {
                streams: (Array.isArray(body["streams"]) ? body["streams"] : [])
                  .slice(-30)
                  .map(streamMetadata),
              }
            : {}),
        };
      }
    }),
  );
  return save();
}
