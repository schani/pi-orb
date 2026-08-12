import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface TestLaunchFailureDecision {
  readonly inject: boolean;
  readonly error?: string;
}

/**
 * Test-composition-only launch seam used by the required replacement E2E.
 * The marker remains armed for the selected incarnation, so a process/container
 * supervisor cannot heal it in place; a higher replacement incarnation starts
 * normally on the same workspace.
 */
export function checkTestLaunchFailure(
  environment: Readonly<Record<string, string | undefined>>,
  workDir: string,
): TestLaunchFailureDecision {
  const markerName = environment["PI_ORB_E2E_LAUNCH_FAILURE_MARKER"];
  if (markerName === undefined || markerName === "") return { inject: false };
  if (isAbsolute(markerName) || normalize(markerName).startsWith("..")) {
    return { inject: false, error: "test launch-failure seam marker must stay under workDir" };
  }
  try {
    const marker = JSON.parse(readFileSync(join(workDir, markerName), "utf8")) as {
      orbId?: unknown;
      incarnation?: unknown;
    };
    const incarnation = Number(environment["PI_ORB_HOST_INCARNATION"] ?? "");
    const inject =
      typeof marker.orbId === "string" &&
      marker.orbId === environment["PI_ORB_ID"] &&
      Number.isSafeInteger(marker.incarnation) &&
      marker.incarnation === incarnation;
    if (inject) {
      appendFileSync(
        join(workDir, ".pi-orb-e2e-launch-failure-events.jsonl"),
        `${JSON.stringify({ orbId: marker.orbId, incarnation, injected: true })}\n`,
        { mode: 0o600 },
      );
    }
    return { inject };
  } catch (error) {
    return { inject: false, error: `test launch-failure seam unavailable: ${String(error)}` };
  }
}
