import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelCallUse } from "../../domain/model-usage.ts";

/**
 * Report every terminal response for the usage ledger without consuming stream events (docs/model-usage.md).
 * pi-durable 1.1.0 generates with `streamSimple` and compacts with `completeSimple`, both under the conversation's
 * `pi.provider` session ID; the contract test pins both.
 */
export function meterModels<T extends Models>(
  models: T,
  rootSessionId: () => string | undefined,
  record: (use: ModelCallUse, response: AssistantMessage) => void,
): T {
  const report = (use: ModelCallUse, response: Promise<AssistantMessage>) =>
    void response.then((message) => record(use, message)).catch(() => undefined);
  return new Proxy(models, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property === "streamSimple")
        return (...args: Parameters<Models["streamSimple"]>) => {
          const stream = Reflect.apply(value, target, args) as ReturnType<Models["streamSimple"]>;
          const sessionId = args[2]?.sessionId;
          report(
            sessionId !== undefined && sessionId === rootSessionId() ? "root" : "subagent",
            stream.result(),
          );
          return stream;
        };
      if (property === "completeSimple")
        return (...args: Parameters<Models["completeSimple"]>) => {
          const response = Reflect.apply(value, target, args) as ReturnType<
            Models["completeSimple"]
          >;
          report("compaction", response);
          return response;
        };
      return value.bind(target);
    },
  });
}
