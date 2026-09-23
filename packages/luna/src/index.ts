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

export interface LunaCompletionError {
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

const failure = (message: string): LunaCompletionError => ({
  type: "luna_completion_error",
  message,
});

/** The one shared Luna request policy for control-plane and orb-runtime presentation calls. */
export function lunaRequestOptions(
  request: Pick<LunaCompletionRequest, "maxTokens" | "sessionPrefix" | "signal">,
): OpenAICodexResponsesOptions {
  return {
    signal: request.signal,
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
      err(failure(`${LUNA_MODEL_ID} is unavailable`)),
    );
  }
  const configuredModel = {
    ...model,
    ...(request.auth.baseUrl !== undefined ? { baseUrl: request.auth.baseUrl } : {}),
  };
  return ResultAsync.fromPromise(
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
    (cause) => failure(cause instanceof Error ? cause.message : String(cause)),
  ).andThen((response) => {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return err(failure(response.errorMessage ?? `Luna stopped with ${response.stopReason}`));
    }
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return text === "" ? err(failure("Luna returned empty text")) : ok(text);
  });
}
