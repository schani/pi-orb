import { describe, expect, it } from "vitest";
import { SKILLS_DIR_ENV } from "./runtime-launch.ts";

describe("runtime launch contract", () => {
  it("names the provider-supplied skills directory", () => {
    expect(SKILLS_DIR_ENV).toBe("PI_ORB_SKILLS_DIR");
  });
});
