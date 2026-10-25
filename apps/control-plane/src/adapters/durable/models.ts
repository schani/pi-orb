import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { durableError } from "./manager.ts";

export interface DurableModelToken {
  readonly accessToken: string;
  readonly generation?: number;
  readonly expiresAt: number;
}
export interface DurableModelsOptions {
  readonly token: (signal?: AbortSignal) => ResultAsync<DurableModelToken, RuntimeClientError>;
  readonly signal?: AbortSignal;
  readonly inferenceBaseUrl?: string;
}

/** Owner-scoped broker credentials; no ambient auth or real refresh token. */
export function createDurableModels(
  options: DurableModelsOptions,
): ResultAsync<Models, RuntimeClientError> {
  type Diagnostics = { brokerGeneration?: number; tokenExpiresAt: number };
  const diagnostics = new Map<string, Diagnostics | undefined>();
  let diagnosticsExhausted = false;
  const resolve = async (signal?: AbortSignal) => {
    const result = await options.token(signal);
    // Pi's auth resolver requires rejection; Models converts it to a typed auth error.
    if (result.isErr() || signal?.aborted)
      return Promise.reject(new Error("owner model credential unavailable"));
    const grant = result.value;
    if (!diagnosticsExhausted && !diagnostics.has(grant.accessToken) && diagnostics.size === 32) {
      // Forgetting bearer history could misattribute a request delayed before provider dispatch.
      diagnostics.clear();
      diagnosticsExhausted = true;
    }
    if (!diagnosticsExhausted) {
      const metadata = {
        tokenExpiresAt: grant.expiresAt,
        ...(grant.generation === undefined ? {} : { brokerGeneration: grant.generation }),
      };
      const previous = diagnostics.get(grant.accessToken);
      diagnostics.set(
        grant.accessToken,
        diagnostics.has(grant.accessToken) &&
          (previous?.brokerGeneration !== metadata.brokerGeneration ||
            previous?.tokenExpiresAt !== metadata.tokenExpiresAt)
          ? undefined
          : metadata,
      );
    }
    return {
      auth: {
        apiKey: grant.accessToken,
        ...(options.inferenceBaseUrl === undefined ? {} : { baseUrl: options.inferenceBaseUrl }),
      },
      source: "owner broker",
    };
  };
  const requestDiagnostics = (apiKey?: string) => {
    const metadata = apiKey ? diagnostics.get(apiKey) : undefined;
    return metadata ? { codexBrokerDiagnostics: metadata } : {};
  };
  return ResultAsync.fromPromise(
    (async () => {
      await resolve(options.signal);
      const models = createModels();
      const provider = openaiCodexProvider();
      const brokerProvider: Provider<"openai-codex-responses"> = {
        ...provider,
        auth: {
          apiKey: { name: "owner broker", resolve: ({ signal }) => resolve(signal) },
        },
        stream: (model, context, requestOptions) =>
          provider.stream<"openai-codex-responses">(model, context, {
            ...requestOptions,
            ...requestDiagnostics(requestOptions?.apiKey),
          }),
        streamSimple: (model, context, requestOptions) =>
          provider.streamSimple(model, context, {
            ...requestOptions,
            ...requestDiagnostics(requestOptions?.apiKey),
          }),
      };
      models.setProvider(brokerProvider);
      return models;
    })(),
    () => durableError("owner model runtime initialization failed", true),
  );
}
