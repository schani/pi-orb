import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelCall } from "../domain/model-usage.ts";

export function modelCall(
  call: Pick<ModelCall, "ownerUserId" | "orbId" | "use">,
  response: AssistantMessage,
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
    ...(response.durationMs === undefined ? {} : { durationMs: response.durationMs }),
  };
}
