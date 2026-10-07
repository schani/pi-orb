const GAP_MS = 60_000;
const ARGUMENT_BYTES = 65_536;
const EVENT_TYPES = new Set([
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
]);

export interface StreamIdentity {
  requestId: string;
  operationId: string | null;
  sessionId: string;
  parentSessionId?: string;
  /** Logical Pi stream invocation, not the provider's internal transport retry. */
  attempt: number;
}

export interface StreamStats extends StreamIdentity {
  startedAt: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  lastEventType: string | null;
  events: number;
  normalizedEvents: number;
  normalizedToolArgumentEvents: number;
  toolArgumentEvents: number;
  lastNormalizedAt: number | null;
  textBytes: number;
  reasoningBytes: number;
  toolArgumentBytes: number;
  phase: "waiting" | "streaming" | "text" | "reasoning" | "tool_arguments" | "terminal";
  transport: "unknown" | "sse";
  httpResponses: number;
  httpStatus: number | null;
  issues: ("no_event_gap" | "large_tool_arguments")[];
}
export type StreamTerminal = "completed" | "aborted" | "failed";
export type StreamAudit = StreamStats & {
  edge: "no_event_gap" | "large_tool_arguments" | "terminal";
  observedAt: number;
  terminal?: StreamTerminal;
};

/** Counts decoded provider delta UTF-8 bytes, never payload serialization or TLS bytes. */
export class StreamTelemetry {
  private readonly active = new Map<symbol, StreamStats>();
  private readonly progress = new Map<symbol, number>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  constructor(now: () => number, monotonicNow: () => number = now) {
    this.now = now;
    this.monotonicNow = monotonicNow;
  }

  start(identity: StreamIdentity): symbol {
    const token = Symbol();
    this.progress.set(token, this.monotonicNow());
    this.active.set(token, {
      ...identity,
      startedAt: this.now(),
      firstEventAt: null,
      lastEventAt: null,
      lastEventType: null,
      events: 0,
      normalizedEvents: 0,
      normalizedToolArgumentEvents: 0,
      toolArgumentEvents: 0,
      lastNormalizedAt: null,
      textBytes: 0,
      reasoningBytes: 0,
      toolArgumentBytes: 0,
      phase: "waiting",
      transport: "unknown",
      httpResponses: 0,
      httpStatus: null,
      issues: [],
    });
    return token;
  }

  providerEvent(token: symbol, data: unknown): void {
    const stats = this.active.get(token);
    if (!stats) return;
    const event =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const type =
      typeof event["type"] === "string" && EVENT_TYPES.has(event["type"]) ? event["type"] : "other";
    const now = this.now();
    stats.firstEventAt ??= now;
    stats.lastEventAt = now;
    this.progress.set(token, this.monotonicNow());
    stats.lastEventType = type;
    stats.events++;
    const delta = typeof event["delta"] === "string" ? event["delta"] : "";
    if (
      type === "response.function_call_arguments.delta" ||
      type === "response.custom_tool_call_input.delta"
    ) {
      stats.toolArgumentEvents++;
      stats.toolArgumentBytes += Buffer.byteLength(delta, "utf8");
      stats.phase = "tool_arguments";
    } else if (type === "response.output_text.delta") {
      stats.textBytes += Buffer.byteLength(delta, "utf8");
      stats.phase = "text";
    } else if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      stats.reasoningBytes += Buffer.byteLength(delta, "utf8");
      stats.phase = "reasoning";
    } else if (stats.phase === "waiting") stats.phase = "streaming";
  }

  normalizedEvent(token: symbol, type: string): void {
    const stats = this.active.get(token);
    if (!stats) return;
    stats.normalizedEvents++;
    if (type === "toolcall_delta") stats.normalizedToolArgumentEvents++;
    stats.lastNormalizedAt = this.now();
  }

  httpResponse(token: symbol, status: number): void {
    const stats = this.active.get(token);
    if (!stats) return;
    stats.transport = "sse";
    stats.httpResponses++;
    stats.httpStatus = status;
  }

  snapshot(): StreamStats[] {
    return [...this.active.values()].map((stats) => ({ ...stats, issues: [...stats.issues] }));
  }

  /** Caller schedules polling through its clock boundary; healthy polls emit nothing. */
  poll(): StreamAudit[] {
    const edges: StreamAudit[] = [];
    const now = this.now();
    for (const [token, stats] of this.active) {
      const candidates: StreamStats["issues"] = [];
      if (this.monotonicNow() - (this.progress.get(token) ?? this.monotonicNow()) >= GAP_MS)
        candidates.push("no_event_gap");
      if (stats.toolArgumentBytes >= ARGUMENT_BYTES) candidates.push("large_tool_arguments");
      for (const edge of candidates) {
        if (stats.issues.includes(edge)) continue;
        stats.issues.push(edge);
        edges.push({ ...stats, issues: [...stats.issues], edge, observedAt: now });
      }
    }
    return edges;
  }

  finish(token: symbol, terminal: StreamTerminal): StreamAudit | null {
    const stats = this.active.get(token);
    if (!stats) return null;
    this.active.delete(token);
    this.progress.delete(token);
    if (terminal === "completed" && stats.issues.length === 0) return null;
    return {
      ...stats,
      issues: [...stats.issues],
      phase: "terminal",
      edge: "terminal",
      observedAt: this.now(),
      terminal,
    };
  }
}
