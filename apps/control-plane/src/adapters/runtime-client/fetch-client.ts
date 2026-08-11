import {
  DeliverOrbMessageResponseSchema,
  type PullHistoryResponse,
  PullHistoryResponseSchema,
  type RuntimeHealth,
  RuntimeHealthSchema,
  RuntimeHttpErrorSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
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
): RuntimeClientError {
  return { type: "runtime_client_error", code, message, retryable };
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

/** Adapter-boundary rendering of a fetch rejection: message plus its cause code. */
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
    url: string,
    context: OperationContext,
    init?: Omit<RequestInit, "signal">,
  ): ResultAsync<{ status: number; body: unknown }, RuntimeClientError> {
    const run = async (): Promise<
      Result<{ status: number; body: unknown }, RuntimeClientError>
    > => {
      const response = await ResultAsync.fromPromise(
        fetch(url, { ...init, signal: context.signal }),
        (error) => {
          const message = describeFetchError(error);
          if (context.signal.aborted) return clientError("cancelled", message, true);
          return clientError("unreachable", message, true);
        },
      );
      if (response.isErr()) return err(response.error);
      const body = await ResultAsync.fromPromise(response.value.json(), (error) =>
        clientError("invalid_response", `unparseable response body: ${String(error)}`, false),
      );
      if (body.isErr()) return err(body.error);
      return ok({ status: response.value.status, body: body.value });
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
      return clientError(code, body.error.message, body.error.retryable);
    }
    return clientError("http_error", `runtime returned HTTP ${status}`, status >= 500);
  }

  deliverMessage(
    _task: SimulationTask,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").DeliverOrbMessageResponse, RuntimeClientError> {
    return this.request(
      `${request.baseUrl}/v1/messages/${encodeURIComponent(request.messageId)}`,
      context,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          messageId: request.messageId,
          messageIds: request.messageIds,
          content: request.content,
        }),
      },
    ).andThen(({ status, body }) => {
      if (status !== 200 && status !== 202) return err(this.mapErrorResponse(status, body));
      if (!Check(DeliverOrbMessageResponseSchema, body)) {
        return err(
          clientError("invalid_response", "message response failed schema validation", false),
        );
      }
      return ok(body);
    });
  }

  health(
    _task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError> {
    return this.request(`${baseUrl}/v1/health`, context).andThen(({ status, body }) => {
      if (status !== 200) {
        return err<RuntimeHealth, RuntimeClientError>(this.mapErrorResponse(status, body));
      }
      if (!Check(RuntimeHealthSchema, body)) {
        return err<RuntimeHealth, RuntimeClientError>(
          clientError("invalid_response", "health response failed schema validation", false),
        );
      }
      return ok(body);
    });
  }

  pullHistory(
    _task: SimulationTask,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError> {
    const params = new URLSearchParams();
    if (request.after !== null) params.set("after", request.after);
    params.set("limit", String(request.limit));
    return this.request(`${request.baseUrl}/v1/history?${params.toString()}`, context).andThen(
      ({ status, body }) => {
        if (status !== 200) {
          return err<PullHistoryResponse, RuntimeClientError>(this.mapErrorResponse(status, body));
        }
        if (!Check(PullHistoryResponseSchema, body)) {
          return err<PullHistoryResponse, RuntimeClientError>(
            clientError("invalid_response", "pull response failed schema validation", false),
          );
        }
        return ok(body);
      },
    );
  }
}
