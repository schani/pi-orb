import { describe, expect, it } from "vitest";
import { lunaRequestOptions } from "./index.ts";

describe("shared Luna request policy", () => {
  it("uses minimal no-tool inference without the unsupported reasoning summary value", () => {
    const options = lunaRequestOptions({
      maxTokens: 64,
      sessionPrefix: "test",
      signal: new AbortController().signal,
    });
    expect(options.reasoningEffort).toBe("minimal");
    expect(options.textVerbosity).toBe("low");
    expect(options.toolChoice).toBe("none");
    expect("reasoningSummary" in options).toBe(false);
    expect(options.sessionId).toMatch(/^test-/);
  });
});
