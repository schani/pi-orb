import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelCall, ModelCallTiming } from "../domain/model-usage.ts";

export function modelCall(
  call: Pick<ModelCall, "ownerUserId" | "orbId" | "use">,
  response: AssistantMessage,
  timing: ModelCallTiming = {},
): ModelCall {
  return {
    ...call,
    provider: response.provider,
    model: response.model,
    outcome: response.stopReason,
    input: response.usage.input,
    output: response.usage.output,
    cacheRead: response.usage.cacheRead,
    cacheWrite: response.usage.cacheWrite,
    costUsd: response.usage.cost.total,
    ...(response.durationMs === undefined ? {} : { durationMs: response.durationMs }),
    ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
    ...timing,
  };
}
