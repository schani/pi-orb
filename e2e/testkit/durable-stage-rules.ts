import { fakeControl } from "../harness.ts";

/** The mock preserves its cursor on replacement; retain consumed rules and auth. */
export async function appendModelStage(
  sessionKey: string,
  rules: readonly unknown[],
  control: typeof fakeControl = fakeControl,
): Promise<void> {
  const detail = await control(sessionKey, "");
  const scenario = detail["scenario"] as Record<string, unknown>;
  const model = scenario["model"] as Record<string, unknown>;
  await control(sessionKey, "/scenario", {
    ...scenario,
    model: { ...model, rules: [...(model["rules"] as unknown[]), ...rules] },
  });
}
