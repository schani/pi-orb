import { describe, expect, it } from "vitest";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { portExposureLoaderOptions } from "./resource-loader.ts";

const host = "pi-orb-abc123.tail1234.ts.net";
const base = { cwd: "/workspace/repo", agentDir: "/workspace/pi-agent", previewHost: host };

describe("portExposureLoaderOptions", () => {
  it("keeps the cwd and agentDir the SDK would have used", () => {
    const options = portExposureLoaderOptions(base);
    expect(options.cwd).toBe("/workspace/repo");
    expect(options.agentDir).toBe("/workspace/pi-agent");
  });

  it("omits settingsManager entirely when none is shared, so the loader defaults", () => {
    expect("settingsManager" in portExposureLoaderOptions(base)).toBe(false);
  });

  it("appends the prompt on top of whatever the loader discovered", () => {
    // The override form is what preserves APPEND_SYSTEM.md discovery; passing
    // `appendSystemPrompt` would have replaced it.
    const override = portExposureLoaderOptions(base).appendSystemPromptOverride;
    expect(override?.(["from APPEND_SYSTEM.md"])).toEqual([
      "from APPEND_SYSTEM.md",
      portExposurePrompt(host),
    ]);
  });

  it("appends the prompt when nothing was discovered", () => {
    const override = portExposureLoaderOptions(base).appendSystemPromptOverride;
    expect(override?.([])).toEqual([portExposurePrompt(host)]);
  });

  it("does not touch the system prompt itself", () => {
    const options = portExposureLoaderOptions(base);
    expect(options.systemPrompt).toBeUndefined();
    expect(options.systemPromptOverride).toBeUndefined();
    expect(options.appendSystemPrompt).toBeUndefined();
  });
});
