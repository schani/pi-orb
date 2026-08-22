import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import { BAKED_SKILLS_DIR, orbResourceLoaderOptions } from "./resource-loader.ts";

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

describe("orbResourceLoaderOptions baked skills", () => {
  let presentDir: string;

  beforeAll(() => {
    presentDir = mkdtempSync(join(tmpdir(), "pi-orb-skills-"));
  });

  afterAll(() => {
    rmSync(presentDir, { recursive: true, force: true });
  });

  it("adds the skills directory when it exists", () => {
    expect(
      orbResourceLoaderOptions({ ...base, skillsDir: presentDir }).additionalSkillPaths,
    ).toEqual([presentDir]);
  });

  it("adds nothing when the directory is absent", () => {
    // The process host provider has no image and therefore no baked skills.
    // A path passed anyway would leave a permanent `error` skill diagnostic on
    // the loader, so the absent case must resolve to no path at all.
    const absent = join(presentDir, "definitely-not-here");
    expect(orbResourceLoaderOptions({ ...base, skillsDir: absent }).additionalSkillPaths).toEqual(
      [],
    );
    expect(orbResourceLoaderOptions({ ...base, skillsDir: null }).additionalSkillPaths).toEqual([]);
  });

  it("defaults to the baked image path", () => {
    // Compared against the explicit form rather than a literal so the
    // assertion holds whether or not this machine happens to have the image
    // path — what is pinned is that omitting the option means the baked dir.
    expect(orbResourceLoaderOptions(base).additionalSkillPaths).toEqual(
      orbResourceLoaderOptions({ ...base, skillsDir: BAKED_SKILLS_DIR }).additionalSkillPaths,
    );
    // Under /workspace the orb's persistent volume would shadow the image's
    // copy, so the baked location must stay outside it.
    expect(BAKED_SKILLS_DIR.startsWith("/workspace")).toBe(false);
  });
});
