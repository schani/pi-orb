import { describe, expect, it } from "vitest";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import { orbResourceLoaderOptions } from "./resource-loader.ts";

const host = "pi-orb-abc123.tail1234.ts.net";
const base = { cwd: "/workspace/repo", agentDir: "/workspace/pi-agent", previewHost: host };

describe("orbResourceLoaderOptions", () => {
  it("keeps the cwd and agentDir the SDK would have used", () => {
    const options = orbResourceLoaderOptions(base);
    expect(options.cwd).toBe("/workspace/repo");
    expect(options.agentDir).toBe("/workspace/pi-agent");
  });

  it("omits settingsManager entirely when none is shared, so the loader defaults", () => {
    expect("settingsManager" in orbResourceLoaderOptions(base)).toBe(false);
  });

  it("appends the prompts on top of whatever the loader discovered", () => {
    // The override form is what preserves APPEND_SYSTEM.md discovery; passing
    // `appendSystemPrompt` would have replaced it.
    const override = orbResourceLoaderOptions(base).appendSystemPromptOverride;
    expect(override?.(["from APPEND_SYSTEM.md"])).toEqual([
      "from APPEND_SYSTEM.md",
      environmentPrompt,
      portExposurePrompt(host),
    ]);
  });

  it("appends runtime tools without a preview host", () => {
    const override = orbResourceLoaderOptions({
      ...base,
      previewHost: null,
    }).appendSystemPromptOverride;
    expect(override?.([])).toEqual([environmentPrompt]);
  });

  it("does not touch the system prompt itself", () => {
    const options = orbResourceLoaderOptions(base);
    expect(options.systemPrompt).toBeUndefined();
    expect(options.systemPromptOverride).toBeUndefined();
    expect(options.appendSystemPrompt).toBeUndefined();
  });
});
