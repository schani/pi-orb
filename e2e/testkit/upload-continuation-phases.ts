import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const stages = [
  "providerprepare",
  "headers",
  "request",
  "firstevent",
  "end",
  "error",
  "toolresult",
  "operationretired",
] as const;
type Stage = (typeof stages)[number];
export interface UploadPhase {
  stage: Stage;
  at: number;
  operationId: string | null;
  callId: string | null;
  requestId: string | null;
}
const id = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9_|-]{1,100}$/.test(value) ? value : null;

/** Never serialize an SDK payload, header, error body, or tool result. */
export function uploadPhaseTail(value: unknown): UploadPhase[] {
  return (Array.isArray(value) ? value : []).slice(-80).flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const row = value as Record<string, unknown>;
    if (
      !stages.includes(row["stage"] as Stage) ||
      typeof row["at"] !== "number" ||
      !Number.isFinite(row["at"]) ||
      row["at"] < 0
    )
      return [];
    return [
      {
        stage: row["stage"] as Stage,
        at: row["at"],
        operationId: id(row["operationId"]),
        callId: id(row["callId"]),
        requestId: id(row["requestId"]),
      },
    ];
  });
}

export class UploadContinuationPhases {
  private rows: UploadPhase[] = [];
  private operationId: string | null = null;
  private callId: string | null = null;
  private requestId: string | null = null;
  private requestSequence = 0;
  private readonly clock: () => number;
  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }
  operation(value: unknown): void {
    this.operationId = id(value);
    this.callId = null;
  }
  record(stage: Stage, callId?: unknown): void {
    if (callId !== undefined) this.callId = id(callId);
    if (stage === "providerprepare") this.requestId = `request-${++this.requestSequence}`;
    this.rows = uploadPhaseTail([
      ...this.rows,
      {
        stage,
        at: this.clock(),
        operationId: this.operationId,
        callId: this.callId,
        requestId: this.requestId,
      },
    ]);
  }
  tail(): UploadPhase[] {
    return uploadPhaseTail(this.rows);
  }
  /** Browser evidence has no SDK provider hooks: do not infer those missing edges. */
  observeFrame(value: unknown): void {
    const object = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const frame = object(value);
    const event = object(frame["event"]);
    if (frame["type"] === "runtime.event") {
      if (event["type"] === "operation_started") this.operation(event["operationId"]);
      if (event["type"] === "tool_state" && event["state"] === "completed")
        this.record("toolresult", event["callId"]);
      if (
        event["type"] === "operation_finished" &&
        this.operationId !== null &&
        id(event["operationId"]) === this.operationId
      )
        this.record("operationretired");
    }
    const record = object(frame["record"]);
    if (
      frame["type"] === "history.record" &&
      record["type"] === "message" &&
      record["role"] === "assistant"
    ) {
      if (record["finishReason"] === "error" || record["finishReason"] === "aborted")
        this.record("error");
      if (record["finishReason"] === "stop") this.record("end");
    }
  }
  /** Headers received are not stream completion. Message end is the normalized outcome. */
  extension(): ExtensionFactory {
    return (pi) => {
      let firstEvent = false;
      pi.on("before_provider_headers", () => {
        firstEvent = false;
        this.record("providerprepare");
      });
      pi.on("before_provider_request", () => {
        this.record("request");
      });
      pi.on("after_provider_response", () => {
        this.record("headers");
      });
      pi.on("provider_stream_event", () => {
        if (!firstEvent) {
          firstEvent = true;
          this.record("firstevent");
        }
      });
      pi.on("tool_execution_end", (event) => {
        this.record("toolresult", event.toolCallId);
      });
      pi.on("message_end", (event) => {
        if (event.message.role === "assistant")
          this.record(
            event.message.stopReason === "error" || event.message.stopReason === "aborted"
              ? "error"
              : "end",
          );
      });
    };
  }
}
