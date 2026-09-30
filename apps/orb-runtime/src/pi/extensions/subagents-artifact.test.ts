import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagents from "@gotgenes/pi-subagents/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = mkdtempSync(join(tmpdir(), "pi-orb-subagents-artifact-"));
  cwd = join(root, "project");
  mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function registeredTool() {
  type RegisteredTool = {
    name: string;
    description: string;
    parameters: {
      properties: { subagent_type: { description: string }; model: { description: string } };
    };
  };
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn() },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),
  };
  subagents(pi as never, { cwd });
  expect(pi.events.emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: {} });
  return tools.get("subagent");
}

describe("installed subagent extension registration", () => {
  it("advertises only the general-purpose builtin without vendor model examples", () => {
    const tool = registeredTool();
    expect(tool).toBeDefined();
    expect(tool?.description).toContain(
      "- general-purpose: General-purpose agent for complex, multi-step tasks",
    );
    expect(tool?.description).not.toMatch(
      /- (Explore|Plan):|Use (Explore|Plan) for|haiku|sonnet|anthropic|claude/i,
    );
    expect(tool?.description).toContain('"provider/modelId"');
    expect(tool?.parameters.properties.subagent_type.description).toContain(
      "Available types: general-purpose.",
    );
    expect(tool?.parameters.properties.model.description).toContain('"provider/modelId"');
    expect(tool?.parameters.properties.model.description).not.toMatch(
      /haiku|sonnet|anthropic|claude/i,
    );
  });

  it("registers a project profile alongside the general-purpose default", () => {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "auditor.md"),
      "---\ndescription: Project auditor\ntools: read, grep\n---\nReview files.",
    );
    const tool = registeredTool();
    expect(tool?.description).toContain(
      "- general-purpose: General-purpose agent for complex, multi-step tasks",
    );
    expect(tool?.description).toContain("- auditor: Project auditor");
    expect(tool?.parameters.properties.subagent_type.description).toContain(
      "Available types: general-purpose, auditor.",
    );
  });
});
