import type { RecordedFakeRequest } from "./harness.ts";

/** The public history snapshot already excludes raw provider diagnostics. */
export function mcpFailureHistory(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null || !("records" in snapshot)) return [];
  const records = snapshot.records;
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record?.role === "assistant" && record.failure)
    .map((record) => ({
      transport: ["sse", "websocket"].includes(record.failure.context?.transport)
        ? record.failure.context.transport
        : undefined,
      phase: ["before_message_stream_start", "after_message_stream_start"].includes(
        record.failure.context?.phase,
      )
        ? record.failure.context.phase
        : undefined,
      wsCloseCode: Number.isInteger(record.failure.context?.wsCloseCode)
        ? record.failure.context.wsCloseCode
        : undefined,
      status: Number.isInteger(record.failure.context?.status)
        ? record.failure.context.status
        : undefined,
      diagnostics: Array.isArray(record.failure.diagnostics)
        ? record.failure.diagnostics.filter((value: unknown) =>
            ["codex_failure", "provider_transport_failure", "stream_aborted"].includes(
              String(value),
            ),
          )
        : [],
    }));
}

/** Failure-only mock ledger: transport outcome and event shape, never prompts or credentials. */
export function mcpFailureRequests(requests: readonly RecordedFakeRequest[]) {
  return requests
    .filter((request) => request.surface === "model")
    .map((request) => ({
      id: request.id,
      createdAt: request["createdAt"],
      status: request["status"],
      matchedRuleIndex: request["matchedRuleIndex"],
      stopReason: request["stopReason"],
      aborted: request["aborted"],
      finalized: request["finalized"],
      eventTypes: Array.isArray(request["events"])
        ? request["events"].map((event: { type?: unknown; kind?: unknown }) => {
            const name = event.type ?? event.kind;
            return typeof name === "string" &&
              [
                "response",
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.output_item.done",
                "response.content_part.added",
                "response.content_part.done",
                "response.output_text.delta",
                "response.output_text.done",
                "response.completed",
                "response.failed",
                "response.incomplete",
                "error",
              ].includes(name)
              ? name
              : "unknown";
          })
        : [],
    }))
    .reverse();
}
