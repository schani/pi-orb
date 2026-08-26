import type { RuntimeHookStatus } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { bootHookPrompt } from "./prompt.ts";

const status = (over: Partial<RuntimeHookStatus>): RuntimeHookStatus => ({
  hook: "setup",
  outcome: "ok",
  exitCode: 0,
  incarnation: "0",
  startedAt: "2026-08-25T00:00:00.000Z",
  endedAt: "2026-08-25T00:01:00.000Z",
  logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
  ...over,
});

describe("boot hook prompt", () => {
  it("says nothing on a healthy boot", () => {
    expect(bootHookPrompt({})).toBeNull();
    expect(bootHookPrompt({ setup: status({}), resume: status({ hook: "resume" }) })).toBeNull();
  });

  it("names the hook, the outcome, and the log path for every failure", () => {
    const prompt = bootHookPrompt({
      setup: status({ outcome: "failed", exitCode: 127 }),
      resume: status({ hook: "resume", outcome: "timeout", exitCode: null }),
    });
    expect(prompt).toContain("`.agents/setup` failed with exit code 127");
    expect(prompt).toContain("/workspace/home/.cache/pi-orb/logs/setup.log");
    expect(prompt).toContain("`.agents/resume` was terminated after exceeding its deadline");
  });

  it("explains a missing execute bit rather than reporting a bare failure", () => {
    const prompt = bootHookPrompt({ setup: status({ outcome: "hook_not_executable" }) });
    expect(prompt).toContain("chmod +x");
  });

  it("says nothing about an env file the runtime used whole", () => {
    expect(
      bootHookPrompt(
        {},
        { path: "/workspace/home/.pi-orb/env", applied: ["FOO"], ignored: [], malformed: [] },
      ),
    ).toBeNull();
  });

  it("reports an env file's refused and unparsable lines, even on a clean boot", () => {
    const prompt = bootHookPrompt(
      {},
      {
        path: "/workspace/home/.pi-orb/env",
        applied: ["FOO"],
        ignored: ["PATH"],
        malformed: [`line 3: no "=" separator`],
      },
    );
    expect(prompt).toContain("/workspace/home/.pi-orb/env");
    expect(prompt).toContain(`line 3: no "=" separator`);
    expect(prompt).toContain("`PATH`, which the runtime owns");
    // The variables that did apply are in the environment already; naming them
    // would spend context on a boot that went right.
    expect(prompt).not.toContain("FOO");
  });
});
