import {
  CommittedDisplayDetailSchema,
  DeliverOrbMessageResponseSchema,
  LiveDisplayDetailSchema,
  type PrepareIdleStopResponse,
  PrepareIdleStopResponseSchema,
  type PullHistoryResponse,
  PullHistoryResponseSchema,
  type RuntimeHealth,
  RuntimeHealthSchema,
  RuntimeHttpErrorSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type {
  DeliverMessageClientRequest,
  OperationContext,
  OrbRuntimeClient,
  PullHistoryClientRequest,
} from "../../domain/ports.ts";

function clientError(
  code: RuntimeClientError["code"],
  message: string,
  retryable: boolean,
  answered: boolean,
): RuntimeClientError {
  return { type: "runtime_client_error", answered, code, message, retryable };
}

/** Bounded walk depth; also the cycle guard for a self-referential cause. */
const CAUSE_DEPTH_LIMIT = 8;

/**
 * First syscall-level `code` reachable from a fetch rejection. undici reports
 * every connection failure as the message "fetch failed" and hides the real
 * reason in `cause` (or, when it tried several addresses, in an
 * `AggregateError`'s `errors`), which is why the 2026-08-06 incident could not
 * tell "no listener in the container" from "host unreachable"
 * (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
 */
function causeCode(error: unknown, depth = 0): string | null {
  if (depth >= CAUSE_DEPTH_LIMIT || typeof error !== "object" || error === null) return null;
  const record = error as { code?: unknown; errors?: unknown; cause?: unknown };
  // DOMException carries a numeric `code`; only a string one is a syscall code.
  if (typeof record.code === "string" && record.code !== "") return record.code;
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const code = causeCode(nested, depth + 1);
      if (code !== null) return code;
    }
  }
  return causeCode(record.cause, depth + 1);
}

/** Adapter-boundary rendering of a fetch rejection. */
export function describeFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode(error);
  return code === null ? message : `${message} (${code})`;
}

/**
 * `fetch`-based runtime client (docs/stack.md): the AbortSignal reaches
 * fetch so a hung request cannot pin a reconciler, responses are validated
 * against the shared TypeBox schemas, and malformed bodies become typed
 * `invalid_response` errors (a replication-integrity condition upstream).
 */
export class FetchRuntimeClient implements OrbRuntimeClient {
  private request(
    task: SimulationTask,
    url: string,
    context: OperationContext,
    init?: Omit<RequestInit, "signal">,
    acceptedStatuses: readonly number[] = [200],
  ): ResultAsync<{ status: number; body: unknown }, RuntimeClientError> {
    const startedAt = task.monotonicNow();
    const transportError = (
      phase: "headers" | "body",
      error: unknown,
      status?: number,
    ): RuntimeClientError => {
      const code = causeCode(error);
      const syscall = code !== null && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unknown";
      return clientError(
        context.signal.aborted ? "cancelled" : "unreachable",
        `runtime request failed origin=${URL.parse(url)?.origin ?? "unknown"} phase=${phase} elapsed_ms=${Math.max(0, Math.round(task.monotonicNow() - startedAt))} http_status=${status ?? "none"} syscall=${syscall} aborted=${context.signal.aborted}`,
        true,
        false,
      );
    };
    const run = async (): Promise<
      Result<{ status: number; body: unknown }, RuntimeClientError>
    > => {
      const response = await ResultAsync.fromPromise(
        fetch(url, { ...init, signal: context.signal }),
        (error) => transportError("headers", error),
      );
      if (response.isErr()) return err(response.error);
      const { status } = response.value;
      const text = await ResultAsync.fromThrowable(
        () => response.value.text(),
        (error) => transportError("body", error, status),
      )();
      if (text.isErr()) return err(text.error);
      const body = Result.fromThrowable(
        (text: string): unknown => JSON.parse(text),
        () =>
          acceptedStatuses.includes(status)
            ? clientError("invalid_response", "unparseable response body", false, true)
            : this.mapErrorResponse(status, undefined),
      )(text.value);
      if (body.isErr()) return err(body.error);
      return ok({ status, body: body.value });
    };
    return new ResultAsync(run());
  }

  private mapErrorResponse(status: number, body: unknown): RuntimeClientError {
    if (Check(RuntimeHttpErrorSchema, body)) {
      const code =
        body.error.code === "cursor_not_found"
          ? "cursor_not_found"
          : body.error.code === "history_unavailable"
            ? "history_unavailable"
            : "http_error";
      return clientError(code, body.error.message, body.error.retryable, true);
    }
    return clientError("http_error", `runtime returned HTTP ${status}`, status >= 500, true);
  }

  deliverMessage(
    task: SimulationTask,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").DeliverOrbMessageResponse, RuntimeClientError> {
    // The runtime keys a batch by its first message id, not the control plane's batch id.
    const messageId = request.messageIds[0] ?? request.messageId;
    return this.request(
      task,
      `${request.baseUrl}/v1/messages/${encodeURIComponent(messageId)}`,
      context,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          messageId,
          messageIds: request.messageIds,
          content: request.content,
          ...(request.system === undefined ? {} : { system: request.system }),
        }),
      },
      [200, 202],
    ).andThen(({ status, body }) => {
      if (status !== 200 && status !== 202) return err(this.mapErrorResponse(status, body));
      if (!Check(DeliverOrbMessageResponseSchema, body)) {
        return err(
          clientError("invalid_response", "message response failed schema validation", false, true),
        );
      }
      return ok(body);
    });
  }

  health(
    task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError> {
    return this.request(task, `${baseUrl}/v1/health`, context).andThen(({ status, body }) => {
      if (status !== 200) {
        return err<RuntimeHealth, RuntimeClientError>(this.mapErrorResponse(status, body));
      }
      if (!Check(RuntimeHealthSchema, body)) {
        return err<RuntimeHealth, RuntimeClientError>(
          clientError("invalid_response", "health response failed schema validation", false, true),
        );
      }
      return ok(body);
    });
  }

  prepareIdleStop(
    task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<PrepareIdleStopResponse, RuntimeClientError> {
    return this.request(task, `${baseUrl}/v1/prepare-idle-stop`, context, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1 }),
    }).andThen(({ status, body }) => {
      if (status !== 200) return err(this.mapErrorResponse(status, body));
      if (!Check(PrepareIdleStopResponseSchema, body))
        return err(
          clientError(
            "invalid_response",
            "idle stop response failed schema validation",
            false,
            true,
          ),
        );
      return ok(body);
    });
  }

  readDisplayDetail(
    task: SimulationTask,
    baseUrl: string,
    sessionId: string,
    recordId: string,
    detailKey: string,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").CommittedDisplayDetail, RuntimeClientError> {
    return this.request(
      task,
      `${baseUrl}/v1/details/${encodeURIComponent(recordId)}/${encodeURIComponent(detailKey)}?sessionId=${encodeURIComponent(sessionId)}`,
      context,
    ).andThen(({ status, body }) =>
      status !== 200
        ? err(this.mapErrorResponse(status, body))
        : Check(CommittedDisplayDetailSchema, body)
          ? ok(body)
          : err(clientError("invalid_response", "detail failed schema validation", false, true)),
    );
  }

  readLiveDisplayDetail(
    task: SimulationTask,
    baseUrl: string,
    operationId: string,
    blockId: string,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").LiveDisplayDetail, RuntimeClientError> {
    return this.request(
      task,
      `${baseUrl}/v1/details/live/${encodeURIComponent(operationId)}/${encodeURIComponent(blockId)}`,
      context,
    ).andThen(({ status, body }) =>
      status !== 200
        ? err(this.mapErrorResponse(status, body))
        : Check(LiveDisplayDetailSchema, body)
          ? ok(body)
          : err(
              clientError("invalid_response", "live detail failed schema validation", false, true),
            ),
    );
  }

  readDisplayImage(
    _task: SimulationTask,
    baseUrl: string,
    sessionId: string,
    recordId: string,
    detailKey: string,
    imageIndex: number,
    context: OperationContext,
  ): ResultAsync<{ mediaType: string; data: Buffer }, RuntimeClientError> {
    const url = `${baseUrl}/v1/images/${encodeURIComponent(recordId)}/${encodeURIComponent(detailKey)}/${imageIndex}?sessionId=${encodeURIComponent(sessionId)}`;
    return ResultAsync.fromPromise(fetch(url, { signal: context.signal }), (error) =>
      clientError(
        context.signal.aborted ? "cancelled" : "unreachable",
        describeFetchError(error),
        true,
        false,
      ),
    ).andThen((response) => {
      if (response.status !== 200)
        return err(
          clientError(
            response.status === 409 ? "cursor_not_found" : "http_error",
            `image HTTP ${response.status}`,
            response.status >= 500,
            true,
          ),
        );
      const mediaType = response.headers.get("content-type");
      if (mediaType === null || !/^image\/(png|jpeg|gif|webp)$/.test(mediaType))
        return err(clientError("invalid_response", "invalid image content type", false, true));
      return ResultAsync.fromPromise(response.arrayBuffer(), () =>
        clientError("invalid_response", "invalid image body", true, true),
      ).map((data) => ({ mediaType, data: Buffer.from(data) }));
    });
  }

  pullHistory(
    task: SimulationTask,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError> {
    const params = new URLSearchParams();
    if (request.after !== null) params.set("after", request.after);
    params.set("limit", String(request.limit));
    return this.request(
      task,
      `${request.baseUrl}/v1/history?${params.toString()}`,
      context,
    ).andThen(({ status, body }) => {
      if (status !== 200) {
        return err<PullHistoryResponse, RuntimeClientError>(this.mapErrorResponse(status, body));
      }
      if (!Check(PullHistoryResponseSchema, body)) {
        return err<PullHistoryResponse, RuntimeClientError>(
          clientError("invalid_response", "pull response failed schema validation", false, true),
        );
      }
      return ok(body);
    });
  }
}
