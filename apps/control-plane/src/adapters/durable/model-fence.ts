import type { Models, ModelsRequestTransforms } from "@earendil-works/pi-ai/models";
import type { ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";

const dispatches = new Set([
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
  "generateImages",
  "classify",
]);

/** pi-ai awaits header transforms immediately before provider dispatch and maps rejection to a stream error. */
export function fenceModels<T extends Models>(
  models: T,
  check: () => ResultAsync<void, RuntimeClientError>,
  signal?: AbortSignal,
): T {
  return new Proxy(models, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (!dispatches.has(String(property))) return value.bind(target);
      return (
        model: unknown,
        context: unknown,
        options: ModelsRequestTransforms & { signal?: AbortSignal } = {},
      ) =>
        Reflect.apply(value, target, [
          model,
          context,
          {
            ...options,
            ...(signal
              ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }
              : {}),
            transformHeaders: async (
              headers: Parameters<NonNullable<ModelsRequestTransforms["transformHeaders"]>>[0],
            ) => {
              const guarded = await check();
              // Framework callback rejection is mapped by pi-ai; raw errors never enter domain services.
              if (guarded.isErr()) return Promise.reject(new Error("Agent ownership revoked"));
              const transformed = options.transformHeaders
                ? await options.transformHeaders(headers)
                : headers;
              const current = await check();
              if (current.isErr()) return Promise.reject(new Error("Agent ownership revoked"));
              return transformed;
            },
          },
        ]);
    },
  });
}
