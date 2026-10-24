import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelCallTiming, ModelCallUse } from "../../domain/model-usage.ts";

/**
 * Times a streamed response from the events pushed into it, without consuming them (docs/model-usage.md). Offsets are
 * measured back from the terminal event and subtracted from the response's own `durationMs`, so they share its origin
 * (the provider request's start, after auth) and stay within it whatever `now` does.
 */
function timeStream(stream: ReturnType<Models["streamSimple"]>, now: () => number) {
  let first: number | undefined;
  let answer: number | undefined;
  let reasoned = false;
  let end: number | undefined;
  const push = stream.push.bind(stream);
  stream.push = (event: AssistantMessageEvent) => {
    if (event.type === "done" || event.type === "error") end ??= now();
    else if (event.type !== "start") {
      const at = now();
      first ??= at;
      if (event.type.startsWith("thinking_")) reasoned ||= answer === undefined;
      else answer ??= at;
    }
    push(event);
  };
  return (response: AssistantMessage): ModelCallTiming => {
    const duration = response.durationMs;
    const last = end;
    if (duration === undefined || last === undefined || first === undefined) return {};
    const offset = (at: number) =>
      Math.min(duration, Math.max(0, duration - Math.round(last - at)));
    const ttftMs = offset(first);
    return reasoned && answer !== undefined
      ? { ttftMs, thinkingMs: Math.max(ttftMs, offset(answer)) }
      : { ttftMs };
  };
}

/**
 * Report every terminal response for the usage ledger without consuming stream events (docs/model-usage.md).
 * pi-durable 1.1.0 generates with `streamSimple` and compacts with `completeSimple`, both under the conversation's
 * `pi.provider` session ID; the contract test pins both. Only streamed responses are timed.
 */
export function meterModels<T extends Models>(
  models: T,
  rootSessionId: () => string | undefined,
  now: () => number,
  record: (use: ModelCallUse, response: AssistantMessage, timing: ModelCallTiming) => void,
): T {
  const report = (
    use: ModelCallUse,
    response: Promise<AssistantMessage>,
    timing: (response: AssistantMessage) => ModelCallTiming = () => ({}),
  ) =>
    void response.then((message) => record(use, message, timing(message))).catch(() => undefined);
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
            timeStream(stream, now),
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
