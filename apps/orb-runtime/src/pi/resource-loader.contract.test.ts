import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpExtension,
  DefaultResourceLoader,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeMcpConfig } from "../mcp/native.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";

/** Pins runtime prompt composition and resource discovery against the installed Pi SDK. */
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

  const orbLoader = async (skillsDir: string | null = null): Promise<ResourceLoader> => {
    const result = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
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

  it("prepends the personal boot snapshot, preserves native files, and removes only personal context when empty", async () => {
    writeFileSync(join(agentDir, "AGENTS.md"), "guest-local instructions");
    const native = (await implicitLoader()).getAgentsFiles().agentsFiles;
    const personalInstructions = { content: "# Personal\nKeep this exact.\n", revision: 7 };
    const loaded = (
      await createOrbResourceLoader({
        cwd: repoDir,
        agentDir,
        skillsDir: null,
        personalInstructions,
      })
    )._unsafeUnwrap();
    expect(loaded.getAgentsFiles().agentsFiles).toEqual([
      { path: "pi-orb:personal/AGENTS.md", content: personalInstructions.content },
      ...native,
    ]);
    personalInstructions.content = "not until next start";
    await loaded.reload();
    expect(loaded.getAgentsFiles().agentsFiles).toEqual([
      { path: "pi-orb:personal/AGENTS.md", content: "# Personal\nKeep this exact.\n" },
      ...native,
    ]);
    const cleared = (
      await createOrbResourceLoader({
        cwd: repoDir,
        agentDir,
        skillsDir: null,
        personalInstructions: { content: "", revision: 8 },
      })
    )._unsafeUnwrap();
    expect(cleared.getAgentsFiles().agentsFiles).toEqual(native);
    expect((await implicitLoader()).getAgentsFiles().agentsFiles).toEqual(native);
  });

  it("adds project instructions after native context, preserving personal context and the immutable boot snapshot", async () => {
    writeFileSync(join(agentDir, "AGENTS.md"), "guest-local instructions");
    const native = (await implicitLoader()).getAgentsFiles().agentsFiles;
    const personalInstructions = { content: "Personal marker", revision: 1 };
    const projectInstructions = { content: "Project marker", revision: 2 };
    const loaded = (
      await createOrbResourceLoader({
        cwd: repoDir,
        agentDir,
        skillsDir: null,
        personalInstructions,
        projectInstructions,
      })
    )._unsafeUnwrap();
    const expected = [
      { path: "pi-orb:personal/AGENTS.md", content: "Personal marker" },
      ...native,
      { path: "pi-orb:project/AGENTS.md", content: "Project marker" },
    ];
    expect(loaded.getAgentsFiles().agentsFiles).toEqual(expected);
    projectInstructions.content = "Not until next start";
    await loaded.reload();
    expect(loaded.getAgentsFiles().agentsFiles).toEqual(expected);
    const cleared = (
      await createOrbResourceLoader({
        cwd: repoDir,
        agentDir,
        skillsDir: null,
        personalInstructions,
        projectInstructions: { content: "", revision: 3 },
      })
    )._unsafeUnwrap();
    expect(cleared.getAgentsFiles().agentsFiles).toEqual(expected.slice(0, -1));
    expect((await implicitLoader()).getAgentsFiles().agentsFiles).toEqual(native);
  });

  it("loads native MCP, tool search and codemode without a catalog, alongside user extensions", async () => {
    const input = { cwd: repoDir, agentDir, skillsDir: null };
    const loaded = (await createOrbResourceLoader(input))._unsafeUnwrap();
    expect(loaded.getAppendSystemPrompt().join("\n")).not.toContain("Available MCP servers:");
    const names = loaded.getExtensions().extensions.flatMap((e) => [...e.tools.keys()]);
    expect(names).toContain("codemode");
    expect(names).toContain("tool_search");
    expect(names).not.toContain("mcp_search");
    expect(names).not.toContain("mcp_call");
    expect(names).not.toContain("mcp_read");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "custom.ts"),
      `export default pi => pi.registerTool({name:'user_tool', label:'user', description:'user', parameters: {type:'object'}, execute: async () => ({content:[]})});`,
    );
    const additive = (await createOrbResourceLoader(input))._unsafeUnwrap();
    expect(additive.getExtensions().extensions.flatMap((e) => [...e.tools.keys()])).toContain(
      "user_tool",
    );
    writeFileSync(
      join(agentDir, "extensions", "collision.ts"),
      `export default pi => pi.registerTool({name:'codemode', label:'collision', description:'collision', parameters: {type:'object'}, execute: async () => ({content:[]})});`,
    );
    expect((await createOrbResourceLoader(input)).isErr()).toBe(true);
  });

  it("rejects discovered tools in the native MCP namespace before any server connects", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "collision.ts"),
      `export default pi => pi.registerTool({name:'mcp__fixture__echo', label:'collision', description:'collision', parameters: {type:'object'}, execute: async () => ({content:[]})});`,
    );
    const result = await createOrbResourceLoader({ cwd: repoDir, agentDir, skillsDir: null });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toContain("mcp__fixture__echo");
  });

  it("appends configured MCP names and descriptions once before native connection, without secrets or legacy tools", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);
    const config = {
      name: "posthog",
      description: "Analytics\nEvents",
      url: "http://127.0.0.1:1/unreachable-secret-url",
      headers: { Authorization: { literal: "Bearer private-token" } },
    };
    const configs = [config];
    const mcp = createMcpExtension({ loadConfig: () => nativeMcpConfig(configs) });
    const loaded = (
      await createOrbResourceLoader({
        cwd: repoDir,
        agentDir,
        skillsDir: null,
        mcp,
        mcpConfigs: configs,
      })
    )._unsafeUnwrap();
    expect(loaded.getExtensions().errors).toEqual([]);
    expect(loaded.getExtensions().extensions.map((extension) => extension.path)).toContain(
      "<inline:pi-orb:mcp>",
    );
    const inventory = "Available MCP servers:\n- posthog: Analytics Events";
    expect(loaded.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt, inventory]);
    config.description = "changed after boot";
    await loaded.reload();
    const prompt = composedAppendSection(loaded) ?? "";
    expect(prompt.split(inventory)).toHaveLength(2);
    expect(prompt).not.toContain("changed after boot");
    expect(prompt).not.toContain("unreachable-secret-url");
    expect(prompt).not.toContain("private-token");
    expect(
      loaded.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
    ).not.toContain("mcp_call");
  });

  it("keeps the boot time zone in the SDK append prompt across reload", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);
    const input = {
      cwd: repoDir,
      agentDir,
      skillsDir: null,
      userTimeZone: "Asia/Tokyo",
    };
    const loaded = (await createOrbResourceLoader(input))._unsafeUnwrap();
    const expected =
      "User’s time zone: Asia/Tokyo. Present dates and times in this time zone unless they request another.";
    expect(loaded.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt, expected]);
    input.userTimeZone = "Europe/Paris";
    await loaded.reload();
    expect(loaded.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt, expected]);
    expect(composedAppendSection(loaded)).toContain(expected);
    expect((await orbLoader()).getAppendSystemPrompt()).toEqual([
      PROJECT_APPEND,
      environmentPrompt,
    ]);
  });

  it("keeps the project-scoped APPEND_SYSTEM.md the SDK discovers", async () => {
    writeFileSync(join(repoDir, PROJECT_CONFIG_DIR, "APPEND_SYSTEM.md"), PROJECT_APPEND);

    const control = await implicitLoader();
    // Guard the fixture: if the SDK ever stops discovering this file, the
    // superset assertion below would pass vacuously.
    expect(control.getAppendSystemPrompt()).toEqual([PROJECT_APPEND]);

    const loader = await orbLoader();
    expect(loader.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt]);
  });

  it("keeps the agent-dir APPEND_SYSTEM.md the SDK discovers", async () => {
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), GLOBAL_APPEND);

    const control = await implicitLoader();
    expect(control.getAppendSystemPrompt()).toEqual([GLOBAL_APPEND]);

    const loader = await orbLoader();
    expect(loader.getAppendSystemPrompt()).toEqual([GLOBAL_APPEND, environmentPrompt]);
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
    expect(composed).toHaveLength(discovered.length + 1);
    expect(composed.at(-1)).toBe(environmentPrompt);

    const section = composedAppendSection(loader);
    expect(section).toBeDefined();
    if (section === undefined) throw new Error("unreachable");
    expect(section.indexOf(PROJECT_APPEND)).toBeLessThan(section.indexOf(environmentPrompt));

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

  it("discovers the image-baked skills through additionalSkillPaths", async () => {
    // The directory the Dockerfile copies to /opt/pi-orb/skills, read from the
    // repository so the shipped SKILL.md is what is actually exercised.
    const loader = await orbLoader(BAKED_SKILLS_SOURCE);
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
      "hosting",
    ]);
  });

  it("discovers bundled skills from the provider-configured source install", async () => {
    const result = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      skillsDir: BAKED_SKILLS_SOURCE,
    });
    if (result.isErr()) throw new Error(`loader build failed: ${result.error}`);

    const hosting = result.value.getSkills().skills.find((skill) => skill.name === "hosting");
    expect(hosting?.filePath).toBe(join(BAKED_SKILLS_SOURCE, "hosting", "SKILL.md"));
    expect(hosting?.description).toContain("HTML explainers");
    expect(result.value.getSkills().diagnostics).toEqual([]);
  });

  it("fails initialization for an explicitly configured missing skills directory", async () => {
    const absent = join(workDir, "no-such-skills-dir");
    const result = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      skillsDir: absent,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toContain(`cannot read configured skills directory ${absent}:`);
  });

  it("fails initialization when the configured skills path is a file", async () => {
    const file = join(workDir, "skills-file");
    writeFileSync(file, "not a directory");
    const result = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      skillsDir: file,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toBe(`configured skills path is not a directory: ${file}`);
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
        return [...base, environmentPrompt];
      },
    });
    expect(unreloaded.getAppendSystemPrompt()).toEqual([]);
    expect(unreloaded.getAgentsFiles().agentsFiles).toEqual([]);
    expect(overrideCalls).toBe(0);

    await unreloaded.reload();
    expect(overrideCalls).toBe(1);
    expect(unreloaded.getAppendSystemPrompt()).toEqual([PROJECT_APPEND, environmentPrompt]);
  });
});
