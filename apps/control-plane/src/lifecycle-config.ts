import { DEFAULT_LIFECYCLE_CONSTANTS, type LifecycleConstants } from "./domain/constants.ts";

export const NATIVE_GCE_UNREACHABLE_BOOT_DEADLINE_MS = 12 * 60_000;

export function lifecycleConstantsForHost(kind: string): LifecycleConstants {
  return kind === "gce"
    ? {
        ...DEFAULT_LIFECYCLE_CONSTANTS,
        unreachableBootDeadlineMs: NATIVE_GCE_UNREACHABLE_BOOT_DEADLINE_MS,
      }
    : DEFAULT_LIFECYCLE_CONSTANTS;
}
