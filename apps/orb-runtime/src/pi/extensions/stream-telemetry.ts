import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Result } from "neverthrow";
import type { InferenceStageAudit } from "../inference-stages.ts";
import type { StreamAudit, StreamTelemetry, StreamTerminal } from "../stream-telemetry.ts";

export interface StreamTelemetryDeps {
  telemetry: StreamTelemetry;
  operationId(): string | null;
  rootSessionId(): string | null;
  audit(edge: StreamAudit): Result<void, { type: "stream_audit_failed" }>;
  stage?(
    edge: Omit<InferenceStageAudit, "observedAt">,
  ): Result<void, { type: "stream_audit_failed" }>;
  failed(): void;
}

/** Each native root/child factory instance owns only its current logical request. */
export function createStreamTelemetryExtension(deps: StreamTelemetryDeps): ExtensionFactory {
  return (pi) => {
    let current: symbol | null = null;
    let closed = false;
    let attempt = 0;
    let operation: string | null = null;
    let headerSequence = 0;
    let headers: Omit<InferenceStageAudit, "edge" | "observedAt"> | null = null;
    const saveHeaders = (edge: InferenceStageAudit["edge"]): void => {
      if (headers !== null && deps.stage?.({ ...headers, edge }).isErr()) deps.failed();
    };
    const save = (edge: StreamAudit | null): void => {
      if (edge !== null && deps.audit(edge).isErr()) deps.failed();
    };
    const finish = (terminal: StreamTerminal): void => {
      if (current === null) return;
      save(deps.telemetry.finish(current, terminal));
      current = null;
    };
    pi.on("before_provider_headers", (_event, context) => {
      if (closed || deps.stage === undefined) return;
      headers = {
        operationId: deps.operationId(),
        sessionId: context.sessionManager.getSessionId(),
        sequence: ++headerSequence,
        stage: "provider_headers",
      };
      saveHeaders("enter");
    });
    pi.on("before_provider_request", (_event, context) => {
      if (closed) return;
      saveHeaders("exit");
      headers = null;
      finish("failed");
      const nextOperation = deps.operationId();
      if (nextOperation !== operation) attempt = 0;
      operation = nextOperation;
      const sessionId = context.sessionManager.getSessionId();
      const rootSessionId = deps.rootSessionId();
      current = deps.telemetry.start({
        requestId: randomUUID(),
        operationId: operation,
        sessionId,
        attempt: ++attempt,
        ...(rootSessionId !== null && rootSessionId !== sessionId
          ? { parentSessionId: rootSessionId }
          : {}),
      });
    });
    pi.on("provider_stream_event", (event) => {
      if (current === null) return;
      for (const edge of deps.telemetry.poll()) save(edge);
      deps.telemetry.providerEvent(current, event.data);
      for (const edge of deps.telemetry.poll()) save(edge);
    });
    pi.on("after_provider_response", (event) => {
      if (current !== null) deps.telemetry.httpResponse(current, event.status);
    });
    pi.on("message_update", (event) => {
      if (current !== null)
        deps.telemetry.normalizedEvent(current, event.assistantMessageEvent.type);
    });
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant") return;
      finish(
        event.message.stopReason === "aborted"
          ? "aborted"
          : event.message.stopReason === "error"
            ? "failed"
            : "completed",
      );
    });
    pi.on("session_shutdown", () => {
      closed = true;
      finish("aborted");
    });
  };
}
