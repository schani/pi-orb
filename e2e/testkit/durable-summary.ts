import { type ControlPlaneHandle, FatalProbeError, waitFor } from "../harness.ts";
import { lifecycleEdge, summaryOutcome } from "./durable-wait-barriers.ts";

export async function waitForSummary(
  cp: ControlPlaneHandle,
  orb: string,
  checkpoint: number,
): Promise<void> {
  const logs = () => [cp.logs.join("").slice(checkpoint)];
  const queued = await waitFor(
    "correlated summary queued",
    async () => lifecycleEdge(logs(), orb, "harness.summary_queued") ?? null,
  );
  const operationId = queued["operationId"];
  if (!operationId) throw new FatalProbeError(`summary missing operation for orb=${orb}`);
  await waitFor(`summary settled for ${operationId}`, async () => {
    const outcome = summaryOutcome(logs(), orb, operationId);
    if (outcome === "failed")
      throw new FatalProbeError(`summary failed for orb=${orb} operation=${operationId}`);
    return outcome === "completed" ? true : null;
  });
}
