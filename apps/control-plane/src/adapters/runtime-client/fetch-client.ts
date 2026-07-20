import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import {
  PullHistoryResponseSchema,
  RuntimeHealthSchema,
  RuntimeHttpErrorSchema,
  type PullHistoryResponse,
  type RuntimeHealth,
} from "@pi-orb/protocol";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type {
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

/**
 * `fetch`-based runtime client (DESIGN.md §17.4): the AbortSignal reaches
 * fetch so a hung request cannot pin a reconciler, responses are validated
 * against the shared TypeBox schemas, and malformed bodies become typed
 * `invalid_response` errors (a replication-integrity condition upstream).
 */
export class FetchRuntimeClient implements OrbRuntimeClient {
  private request(
    url: string,
    context: OperationContext,
  ): ResultAsync<{ status: number; body: unknown }, RuntimeClientError> {
    const run = async (): Promise<
      Result<{ status: number; body: unknown }, RuntimeClientError>
    > => {
      const response = await ResultAsync.fromPromise(
        fetch(url, { signal: context.signal }),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
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
