import { describe, expect, it } from "vitest";
import { orbNameRequestOptions } from "./pi-name-generator.ts";

describe("PiOrbNameGenerator request options", () => {
  it("does not send the unsupported reasoning summary off value", () => {
    const options = orbNameRequestOptions("session", new AbortController().signal);
    expect(options.reasoningEffort).toBe("minimal");
    expect("reasoningSummary" in options).toBe(false);
    expect(options.toolChoice).toBe("none");
  });
});
