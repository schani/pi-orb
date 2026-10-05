import { randomUUID } from "node:crypto";
import type {
  Api,
  Model,
  OpenAICodexResponsesOptions,
  ProviderEnv,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { err, ok, ResultAsync } from "neverthrow";

export const LUNA_MODEL_ID = "gpt-6-luna";

export interface LunaFailureDiagnostics {
  readonly reason?:
    | "model_unavailable"
    | "completion_rejected"
    | "provider_error"
    | "aborted"
    | "empty_text"
    | undefined;
  readonly providerStatus?: number | undefined;
  readonly transport?: "sse" | "websocket" | undefined;
  readonly phase?: "before_message_stream_start" | "after_message_stream_start" | undefined;
  readonly stopReason?: "error" | "aborted" | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly errorCode?:
    | "invalid_api_key"
    | "invalid_grant"
    | "unauthorized"
    | "authentication_error"
    | "invalid_token"
    | "rate_limit_exceeded"
    | "usage_limit_reached"
    | "insufficient_quota"
    | "websocket_connection_limit_reached"
    | "previous_response_not_found"
    | undefined;
}

export interface LunaCompletionError extends LunaFailureDiagnostics {
  readonly type: "luna_completion_error";
  readonly message: string;
}

export interface LunaCompletionRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly timestamp: number;
  readonly maxTokens: number;
  readonly sessionPrefix: string;
  readonly signal: AbortSignal;
  /** Runtime callers pass a composed provider model whose transport override must be retained. */
  readonly modelTemplate?: Model<Api>;
  readonly auth: {
    readonly apiKey?: string;
    readonly headers?: ProviderHeaders;
    readonly env?: ProviderEnv;
    readonly baseUrl?: string;
  };
}

const failure = (message: string, diagnostics: LunaFailureDiagnostics): LunaCompletionError => ({
  type: "luna_completion_error",
  message,
  ...diagnostics,
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeErrorCode(value: unknown): LunaFailureDiagnostics["errorCode"] {
  switch (value) {
    case "invalid_api_key":
    case "invalid_grant":
    case "unauthorized":
    case "authentication_error":
    case "invalid_token":
    case "rate_limit_exceeded":
    case "usage_limit_reached":
    case "insufficient_quota":
    case "websocket_connection_limit_reached":
    case "previous_response_not_found":
      return value;
    default:
      return undefined;
  }
}

/** SDK diagnostics are extensible; only the last Codex failure describes the terminal transport. */
function terminalDiagnostics(response: unknown): LunaFailureDiagnostics {
  if (!object(response)) return {};
  const diagnostics: unknown = response.diagnostics;
  const terminal: unknown = Array.isArray(diagnostics)
    ? diagnostics.findLast((entry: unknown) => object(entry) && entry.type === "codex_failure")
    : undefined;
  const usage = object(response.usage) ? response.usage : {};
  return {
    ...(object(terminal)
      ? {
          providerStatus:
            typeof terminal.status === "number" &&
            Number.isInteger(terminal.status) &&
            terminal.status >= 100 &&
            terminal.status <= 599
              ? terminal.status
              : undefined,
          transport:
            terminal.transport === "sse" || terminal.transport === "websocket"
              ? terminal.transport
              : undefined,
          phase:
            terminal.phase === "before_message_stream_start" ||
            terminal.phase === "after_message_stream_start"
              ? terminal.phase
              : undefined,
          errorCode: safeErrorCode(terminal.code),
        }
      : {}),
    inputTokens: safeCount(usage.input),
    outputTokens: safeCount(usage.output),
    reasoningTokens: safeCount(usage.reasoning),
  };
}

/** The one shared Luna request policy for control-plane and orb-runtime presentation calls. */
export function lunaRequestOptions(
  request: Pick<LunaCompletionRequest, "maxTokens" | "sessionPrefix" | "signal">,
): OpenAICodexResponsesOptions {
  return {
    signal: request.signal,
    maxRetries: 0,
    transport: "sse",
    maxTokens: request.maxTokens,
    reasoningEffort: "minimal",
    textVerbosity: "low",
    toolChoice: "none",
    sessionId: `${request.sessionPrefix}-${randomUUID()}`,
  };
}

export function resolveLunaModel(modelTemplate?: Model<Api>): Model<Api> | undefined {
  const catalogModel = openaiCodexProvider()
    .getModels()
    .find((candidate) => candidate.id === LUNA_MODEL_ID);
  if (catalogModel === undefined) return undefined;
  return {
    ...catalogModel,
    ...(modelTemplate?.baseUrl !== undefined ? { baseUrl: modelTemplate.baseUrl } : {}),
  };
}

export function completeLuna(
  request: LunaCompletionRequest,
): ResultAsync<string, LunaCompletionError> {
  const model = resolveLunaModel(request.modelTemplate);
  if (model === undefined) {
    return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
      err(failure(`${LUNA_MODEL_ID} is unavailable`, { reason: "model_unavailable" })),
    );
  }
  const configuredModel = {
    ...model,
    ...(request.auth.baseUrl !== undefined ? { baseUrl: request.auth.baseUrl } : {}),
  };
  return ResultAsync.fromThrowable(
    () =>
      complete(
        configuredModel,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.prompt, timestamp: request.timestamp }],
        },
        {
          ...lunaRequestOptions(request),
          ...(request.auth.apiKey !== undefined ? { apiKey: request.auth.apiKey } : {}),
          ...(request.auth.headers !== undefined ? { headers: request.auth.headers } : {}),
          ...(request.auth.env !== undefined ? { env: request.auth.env } : {}),
        },
      ),
    () => failure("Luna completion rejected", { reason: "completion_rejected" }),
  )().andThen((response) => {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return err(
        failure(response.errorMessage ?? `Luna stopped with ${response.stopReason}`, {
          ...(response.stopReason === "error" ? terminalDiagnostics(response) : {}),
          reason: response.stopReason === "error" ? "provider_error" : "aborted",
          stopReason: response.stopReason,
        }),
      );
    }
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return text === ""
      ? err(failure("Luna returned empty text", { reason: "empty_text" }))
      : ok(text);
  });
}
