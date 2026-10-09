import type { Context, JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ResultAsync } from "neverthrow";
import { LazyExecutionEnv } from "../execution-client/lazy-env.ts";
import { durableError } from "./manager.ts";

/** One publisher owns invocation wait state and nested tool details. */
export function executionWaitProgress(
  api: ToolExecutionApi,
  ctx: Context,
  phase: (phase: "waiting" | "ready" | "failed" | "cancelled") => void,
): ToolExecutionApi {
  if (!(api.env instanceof LazyExecutionEnv)) return api;
  let waiting = false;
  let details: Record<string, JsonValue> = {};
  const publish = () =>
    api.details({ ...details, executionWait: waiting || details.executionWait === true }, ctx);
  api.env.observeWait((next) => {
    waiting = next === "waiting";
    phase(next);
    return ResultAsync.fromPromise(publish(), () =>
      durableError("execution wait publication failed"),
    );
  });
  return {
    ...api,
    details: async (value, context) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        details = value;
        await publish();
      } else {
        await api.details(value, context);
      }
    },
  };
}
