import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";

/**
 * Pinned Pi SDK contract test (docs/ports.md): verifies, against the exact
 * installed `@earendil-works/pi-coding-agent` version, that the Tailscale
 * port-exposure prompt really composes through a real `DefaultResourceLoader`
 * — the sibling unit suite (`resource-loader.test.ts`) only checks the pure
 * options builder, so nothing there would notice the SDK changing underneath.
 *
 * The seam being pinned: `AgentSession` reads exactly two prompt accessors off
 * the loader (`agent-session.js`: `getSystemPrompt()` and
 * `getAppendSystemPrompt()`), joins the append array with a blank line, and
 * hands the result to `buildSystemPrompt` as `appendSystemPrompt`. That builder
 * is not re-exported from the package entry point, so `getAppendSystemPrompt()`
 * is the narrowest honest surface reachable without standing up a model
 * runtime; these tests pin it plus the blank-line join the session performs.
 *
 * Pinned contract:
 *  1. `appendSystemPromptOverride` is invoked during `reload()`, and the
 *     port-exposure section — preview host, `http://<host>:<port>` shape —
 *     lands verbatim in `getAppendSystemPrompt()`.
 *  2. Our loader is a strict superset of the implicit loader
 *     `createAgentSession` builds when it gets no `resourceLoader`: the SDK's
 *     own `APPEND_SYSTEM.md` discovery (project `.pi/` and global agent-dir
 *     variants), `SYSTEM.md` discovery, and AGENTS.md context files all still
 *     load, byte-identically to a control loader.
 *  3. Ordering: discovered append content, runtime tools, then optional ports.
 *  4. Without a preview host the runtime-tools section remains present while
 *     the port-exposure section is absent.
 *  5. `reload()` is mandatory: a freshly constructed loader has an empty
 *     append array and has never called the override.
 *  6. `additionalSkillPaths` really discovers the image-baked skills directory
 *     through `getSkills()`, and an absent directory stays harmless.
 *
 * Every control-equality test passes `skillsDir: null` explicitly: the
 * production default is the image path `/opt/pi-orb/skills`, and this suite
 * must compare the same skill set as the control loader whether or not it
 * happens to run inside an orb image that has it.
 */

const PREVIEW_HOST = "pi-orb-test.tailabc.ts.net";
/** Repository source of what the Dockerfile bakes at `BAKED_SKILLS_DIR`. */
const BAKED_SKILLS_SOURCE = join(import.meta.dirname, "../../skills");
/** `CONFIG_DIR_NAME` in the SDK (`config.js`), i.e. the project-scoped `.pi/`. */
const PROJECT_CONFIG_DIR = ".pi";
const PROJECT_APPEND = "project-scoped APPEND_SYSTEM.md marker";
const GLOBAL_APPEND = "agent-dir APPEND_SYSTEM.md marker";
const AGENTS_MD = "AGENTS.md marker for the fixture repo";

describe("Pi SDK resource loader contract (pinned SDK version)", () => {
  let workDir: string;
  let repoDir: string;
  let agentDir: string;

  /**
   * The control: byte-for-byte what `createAgentSession` constructs when no
   * `resourceLoader` is supplied (`sdk.js`:
   * `new DefaultResourceLoader({ cwd, agentDir, settingsManager })` then
   * `await reload()`). The session's `settingsManager` is
   * `SettingsManager.create(cwd, agentDir)`, which is also what the loader
   * defaults to when the option is omitted — so omitting it here keeps the
   * control equivalent while matching how the runtime calls us in production
   * (no shared manager outside the mock-OpenAI path).
   */
  const implicitLoader = async (): Promise<ResourceLoader> => {
    const loader = new DefaultResourceLoader({ cwd: repoDir, agentDir });
    await loader.reload();
    return loader;
  };

  const orbLoader = async (
    previewHost: string | null = PREVIEW_HOST,
    skillsDir: string | null = null,
  ): Promise<ResourceLoader> => {
    const result = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      previewHost,
      skillsDir,
    });
    if (result.isErr()) throw new Error(`loader build failed: ${result.error}`);
    return result.value;
  };

  /** What `AgentSession` actually forwards as `appendSystemPrompt`. */
  const composedAppendSection = (loader: ResourceLoader): string | undefined => {
    const parts = loader.getAppendSystemPrompt();
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pi-orb-loader-contract-"));
    repoDir = join(workDir, "repo");
    agentDir = join(workDir, "pi-agent");
    mkdirSync(join(repoDir, PROJECT_CONFIG_DIR), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(repoDir, "AGENTS.md"), AGENTS_MD);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("puts the port-exposure section into the prompt the session reads", async () => {
    const loader = await orbLoader();

    const parts = loader.getAppendSystemPrompt();
    expect(parts).toContain(portExposurePrompt(PREVIEW_HOST));

    const section = composedAppendSection(loader);
    expect(section).toBeDefined();
    expect(section).toContain("## Port exposure");
    expect(section).toContain(PREVIEW_HOST);
    // The two shapes the agent needs: the generic rule and a concrete URL.
    expect(section).toContain(`http://${PREVIEW_HOST}:<port>`);
    expect(section).toContain(`http://${PREVIEW_HOST}:5173`);
  });

  it("keeps the project-scoped APPEND_SYSTEM.md the SDK discovers", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);

    const control = await implicitLoader();
    // Guard the fixture: if the SDK ever stops discovering this file, the
    // superset assertion below would pass vacuously.
    expect(control.getAppendSystemPrompt()).toEqual([PROJECT_APPEND]);

    const loader = await orbLoader();
    expect(loader.getAppendSystemPrompt()).toEqual([
      PROJECT_APPEND,
      environmentPrompt,
      portExposurePrompt(PREVIEW_HOST),
    ]);
  });

  it("keeps the agent-dir APPEND_SYSTEM.md the SDK discovers", async () => {
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), GLOBAL_APPEND);

    const control = await implicitLoader();
    expect(control.getAppendSystemPrompt()).toEqual([GLOBAL_APPEND]);

    const loader = await orbLoader();
    expect(loader.getAppendSystemPrompt()).toEqual([
      GLOBAL_APPEND,
      environmentPrompt,
      portExposurePrompt(PREVIEW_HOST),
    ]);
  });

  it("is a strict superset of the implicit loader, with our section last", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);
    writeFileSync(join(agentDir, "SYSTEM.md"), "agent-dir SYSTEM.md marker");

    const control = await implicitLoader();
    const loader = await orbLoader();

    const discovered = control.getAppendSystemPrompt();
    const composed = loader.getAppendSystemPrompt();
    // Everything the implicit loader found, in order, then our section — we
    // append to `base`, we never reorder or drop it.
    expect(composed.slice(0, discovered.length)).toEqual(discovered);
    expect(composed).toHaveLength(discovered.length + 2);
    expect(composed.at(-1)).toBe(portExposurePrompt(PREVIEW_HOST));

    const section = composedAppendSection(loader);
    expect(section).toBeDefined();
    if (section === undefined) throw new Error("unreachable");
    expect(section.indexOf(PROJECT_APPEND)).toBeLessThan(section.indexOf("## Port exposure"));

    // The rest of the loader's surface is untouched: we override only the
    // append array, so SYSTEM.md, AGENTS.md context files, and the discovered
    // resources must match the control exactly.
    expect(loader.getSystemPrompt()).toBe(control.getSystemPrompt());
    expect(loader.getSystemPrompt()).toBe("agent-dir SYSTEM.md marker");
    expect(loader.getAgentsFiles()).toEqual(control.getAgentsFiles());
    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { path: join(repoDir, "AGENTS.md"), content: AGENTS_MD },
    ]);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(
      control.getSkills().skills.map((skill) => skill.name),
    );
    expect(loader.getPrompts().prompts).toEqual(control.getPrompts().prompts);
    expect(loader.getThemes().themes).toEqual(control.getThemes().themes);
  });

  it("keeps runtime tools but omits port exposure without a preview host", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);

    const loader = await orbLoader(null);
    expect(loader.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt]);
    expect(composedAppendSection(loader)).not.toContain("## Port exposure");
    expect(composedAppendSection(loader)).not.toContain(PREVIEW_HOST);
  });

  it("discovers the image-baked skills through additionalSkillPaths", async () => {
    // The directory the Dockerfile copies to /opt/pi-orb/skills, read from the
    // repository so the shipped SKILL.md is what is actually exercised.
    const loader = await orbLoader(PREVIEW_HOST, BAKED_SKILLS_SOURCE);
    const { skills, diagnostics } = loader.getSkills();

    for (const name of ["boot-hooks", "cloud-identity"]) {
      const baked = skills.find((skill) => skill.name === name);
      expect(baked, `discovered: ${skills.map((s) => s.name).join(", ")}`).toBeDefined();
      // The description is the only part always in the agent's context, so an
      // empty one would mean a silently undiscoverable skill.
      expect(baked?.description.length).toBeGreaterThan(0);
      expect(baked?.disableModelInvocation).toBe(false);
      expect(baked?.filePath).toBe(join(BAKED_SKILLS_SOURCE, name, "SKILL.md"));
    }
    expect(diagnostics).toEqual([]);

    // Adding skills must not disturb the rest of the loader's surface.
    const control = await implicitLoader();
    expect(loader.getSystemPrompt()).toBe(control.getSystemPrompt());
    expect(loader.getAgentsFiles()).toEqual(control.getAgentsFiles());
    expect(loader.getPrompts().prompts).toEqual(control.getPrompts().prompts);
    // The skills are strictly additive on top of whatever the SDK discovered.
    const controlNames = control.getSkills().skills.map((skill) => skill.name);
    expect(skills.map((skill) => skill.name)).toEqual([
      ...controlNames,
      "boot-hooks",
      "cloud-identity",
    ]);
  });

  it("tolerates a missing skills directory, as on a provider with no image", async () => {
    // The process host provider never has /opt/pi-orb/skills. `existsSync`
    // filtering in the options builder is what keeps this quiet: passing the
    // path anyway makes `reload()` record a `type: "error"` skill diagnostic.
    const absent = join(workDir, "no-such-skills-dir");
    const loader = await orbLoader(PREVIEW_HOST, absent);
    const control = await implicitLoader();

    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(
      control.getSkills().skills.map((skill) => skill.name),
    );
    // The prompt sections are unaffected by the skills path either way.
    expect(loader.getAppendSystemPrompt()).toContain(portExposurePrompt(PREVIEW_HOST));
  });

  it("requires the reload() that createOrbResourceLoader awaits", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);
    let overrideCalls = 0;

    // Constructing the loader resolves nothing: the SDK applies
    // `appendSystemPromptOverride` inside `reload()`, never in the
    // constructor. A loader handed to `createAgentSession` unreloaded would
    // silently drop both the discovered file and our section.
    const unreloaded = new DefaultResourceLoader({
      cwd: repoDir,
      agentDir,
      appendSystemPromptOverride: (base: string[]): string[] => {
        overrideCalls += 1;
        return [...base, environmentPrompt, portExposurePrompt(PREVIEW_HOST)];
      },
    });
    expect(unreloaded.getAppendSystemPrompt()).toEqual([]);
    expect(unreloaded.getAgentsFiles().agentsFiles).toEqual([]);
    expect(overrideCalls).toBe(0);

    await unreloaded.reload();
    expect(overrideCalls).toBe(1);
    expect(unreloaded.getAppendSystemPrompt()).toEqual([
      PROJECT_APPEND,
      environmentPrompt,
      portExposurePrompt(PREVIEW_HOST),
    ]);
  });
});
