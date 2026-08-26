import { describe, expect, it } from "vitest";
import { bootHookPrompt } from "../hooks/prompt.ts";
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

  it("appends nothing for boot hooks that succeeded", () => {
    const override = orbResourceLoaderOptions({
      ...base,
      previewHost: null,
      hooks: {
        setup: {
          hook: "setup",
          outcome: "ok",
          exitCode: 0,
          incarnation: "0",
          startedAt: "2026-08-25T00:00:00.000Z",
          endedAt: "2026-08-25T00:00:10.000Z",
          logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
        },
      },
    }).appendSystemPromptOverride;
    expect(override?.([])).toEqual([environmentPrompt]);
  });

  it("tells the agent about a failed boot hook", () => {
    const hooks = {
      setup: {
        hook: "setup" as const,
        outcome: "failed" as const,
        exitCode: 1,
        incarnation: "0",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:10.000Z",
        logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
      },
    };
    const override = orbResourceLoaderOptions({
      ...base,
      previewHost: null,
      hooks,
    }).appendSystemPromptOverride;
    expect(override?.([])).toEqual([environmentPrompt, bootHookPrompt(hooks)]);
  });

  it("does not touch the system prompt itself", () => {
    const options = orbResourceLoaderOptions(base);
    expect(options.systemPrompt).toBeUndefined();
    expect(options.systemPromptOverride).toBeUndefined();
    expect(options.appendSystemPrompt).toBeUndefined();
  });
});
