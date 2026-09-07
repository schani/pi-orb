import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "./domain/constants.ts";
import {
  lifecycleConstantsForHost,
  NATIVE_GCE_UNREACHABLE_BOOT_DEADLINE_MS,
} from "./lifecycle-config.ts";

describe("host lifecycle timing composition", () => {
  it("allows native GCE workspace preparation to reach runtime health", () => {
    const constants = lifecycleConstantsForHost("gce");
    expect(constants.unreachableBootDeadlineMs).toBe(12 * 60_000);
    expect(constants.unreachableBootDeadlineMs).toBe(NATIVE_GCE_UNREACHABLE_BOOT_DEADLINE_MS);
    expect(constants.unreachableBootDeadlineMs).toBeLessThan(constants.createStartDeadlineMs);
  });

  it.each(["docker", "process"])("keeps the default deadline for %s", (kind) => {
    expect(lifecycleConstantsForHost(kind)).toBe(DEFAULT_LIFECYCLE_CONSTANTS);
  });
});
