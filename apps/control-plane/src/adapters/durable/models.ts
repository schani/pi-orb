import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

/** Owner-scoped broker credentials; no ambient auth path, environment mutation or real refresh token. */
export function createDurableModels(
  options: DurableModelsOptions,
): ResultAsync<ModelRuntime, RuntimeClientError> {
  const diagnostics = new Map<string, { brokerGeneration?: number; tokenExpiresAt: number }>();
  const resolve = async (signal?: AbortSignal) => {
    const result = await options.token(signal);
    // The provider OAuth callback requires rejection on failure; neverthrow is restored at our outer boundary.
    if (result.isErr()) return Promise.reject(new Error("owner model credential unavailable"));
    const grant = result.value;
    diagnostics.set(grant.accessToken, {
      tokenExpiresAt: grant.expiresAt,
      ...(grant.generation === undefined ? {} : { brokerGeneration: grant.generation }),
    });
    if (diagnostics.size > 32) diagnostics.delete(diagnostics.keys().next().value as string);
    return {
      type: "oauth" as const,
      access: grant.accessToken,
      refresh: "pi-orb-broker",
      expires: grant.expiresAt,
    };
  };
  return ResultAsync.fromPromise(
    (async () => {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai-codex", () => resolve(options.signal));
      const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerProvider("openai-codex", {
        name: "OpenAI Codex (central broker)",
        ...(options.inferenceBaseUrl === undefined ? {} : { baseUrl: options.inferenceBaseUrl }),
        getRequestDiagnostics: (bearer) => diagnostics.get(bearer),
        oauth: {
          name: "pi-orb broker",
          login: (callbacks) => resolve(callbacks.signal),
          refreshToken: (_credential, signal) => resolve(signal),
          getApiKey: (credential) => credential.access,
        },
      });
      await runtime.getAvailable(
        "openai-codex",
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return runtime;
    })(),
    () => durableError("owner model runtime initialization failed", true),
  );
}
