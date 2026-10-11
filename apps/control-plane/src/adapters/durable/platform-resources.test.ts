import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SnapshotResourceReader } from "../../domain/resources.ts";
import { snapshotPromptResources } from "../git-resources/prompt.ts";
import { loadPlatformResources } from "./platform-resources.ts";
import { renderPrompt } from "./prompt.ts";

it("loads only application-owned bundled skills into private virtual paths", async () => {
  const loaded = (
    await loadPlatformResources(
      fileURLToPath(new URL("../../../../orb-runtime/skills/", import.meta.url)),
    )
  )._unsafeUnwrap();
  expect(
    loaded
      .filter((file) => file.path.endsWith("/SKILL.md"))
      .map((file) => file.path)
      .sort(),
  ).toEqual([
    "/opt/pi-orb/skills/boot-hooks/SKILL.md",
    "/opt/pi-orb/skills/cloud-identity/SKILL.md",
    "/opt/pi-orb/skills/codemode-manual/SKILL.md",
    "/opt/pi-orb/skills/codemode-quick-reference/SKILL.md",
    "/opt/pi-orb/skills/hosting/SKILL.md",
  ]);
  expect(loaded.every((file) => file.sha256.length === 64)).toBe(true);
  const reader = new SnapshotResourceReader({
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: "/opt/pi-orb/skills",
    files: loaded,
  });
  const cloud = Buffer.from(
    (await reader.read("/opt/pi-orb/skills/cloud-identity/SKILL.md"))._unsafeUnwrap(),
  ).toString();
  expect(cloud).toContain("/opt/pi-orb/skills/boot-hooks/SKILL.md");
  expect(
    Buffer.from(
      (await reader.read("/opt/pi-orb/skills/boot-hooks/SKILL.md"))._unsafeUnwrap(),
    ).toString(),
  ).toContain("name:");
});

async function codemodeBundle() {
  const files = (
    await loadPlatformResources(
      fileURLToPath(new URL("../../../../orb-runtime/skills/", import.meta.url)),
    )
  )._unsafeUnwrap();
  return {
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: "/opt/pi-orb/skills",
    files,
  };
}

const codemodeSkills = [
  {
    name: "codemode-quick-reference",
    description:
      "Brief code-mode overview, example and all pi-orb code-mode limits. Read for syntax reminders or sandbox/resource-limit failures.",
  },
  {
    name: "codemode-manual",
    description:
      "Full code-mode scripting manual: tool discovery, result types, state, concurrency, output and failure handling. Read for detailed API usage.",
  },
];

it("discovers both skill metadata without bodies and reads snapshots on demand", async () => {
  const bundle = await codemodeBundle();
  const resources = snapshotPromptResources(bundle)._unsafeUnwrap();
  const prompt = renderPrompt({ cwd: "/guest/repo", repository: [], skills: resources.skills });
  const reader = new SnapshotResourceReader(bundle);
  for (const { name, description } of codemodeSkills) {
    const skill = resources.skills.find((skill) => skill.name === name);
    expect(skill).toBeDefined();
    expect(skill?.disableModelInvocation).toBe(false);
    expect(skill?.description).toBe(description);
    const path = `/opt/pi-orb/skills/${name}/SKILL.md`;
    expect(skill?.filePath).toBe(path);
    expect(prompt).toContain(path);
    expect(prompt).toContain(description);
    const content = Buffer.from((await reader.read(path))._unsafeUnwrap()).toString();
    const body = content.split("---").slice(2).join("---").trim();
    expect(body.length).toBeGreaterThan(100);
    expect(prompt).not.toContain(body);
    expect(JSON.stringify(resources.skills)).not.toContain(body);
    expect(bundle.files.filter((file) => file.path === path)).toHaveLength(1);
  }
  expect(bundle.files.filter(({ path }) => path.includes("/codemode"))).toHaveLength(2);
  expect(prompt).not.toContain("262144");
  expect(prompt).not.toContain("structuredContent");
});

it("provides a bounded example, relevant caps and stable bundled-manual guidance", async () => {
  const bundle = await codemodeBundle();
  const file = bundle.files.find(({ path }) => path.endsWith("/codemode-quick-reference/SKILL.md"));
  expect(file).toBeDefined();
  const content = Buffer.from(file?.bytes ?? []).toString();
  for (const requirement of [
    /tools\.read[\s\S]*package\.json[\s\S]*JSON\.parse[\s\S]*store\(/,
    /262144[\s\S]*1048576[\s\S]*keys/i,
    /256\s*MiB[\s\S]*heap/i,
    /CPU:[\s\S]*1 core[\s\S]*shared[\s\S]*20 ms[\s\S]*deadlines/i,
    /5\s*min[\s\S]*@options/,
    /10000[\s\S]*estimated tokens[\s\S]*4 characters\/token/i,
    /timeout_ms[\s\S]*positive integer[\s\S]*2147483647/i,
    /max_output_tokens[\s\S]*nonnegative safe integer[\s\S]*9007199254740991/i,
    /8\s*outstanding[\s\S]*256\s*cumulative[\s\S]*8\s*MiB[\s\S]*64\s*MiB/i,
    /JSON[\s\S]*UTF-8[\s\S]*escap/i,
    /discovery[\s\S]*share/i,
    /Emitted output[\s\S]*1\s*MiB[\s\S]*32\s*MiB[\s\S]*4096/i,
    /bash[\s\S]*1\s*MiB[\s\S]*UTF-8[\s\S]*full_output_path/i,
    /2000[\s\S]*50\s*KiB[\s\S]*offset[\s\S]*limit/i,
    /20\s*MiB[\s\S]*fallback/i,
    /artifact[\s\S]*16\s*MiB/i,
    /remote[\s\S]*HTTP requests[\s\S]*whole-file reads[\s\S]*16\s*MiB[\s\S]*raw file[\s\S]*lower/i,
    /no[\s\S]*Node[\s\S]*filesystem[\s\S]*network[\s\S]*timers/i,
    /fresh VM/i,
    /load[\s\S]*cop/i,
    /successful[\s\S]*store/i,
    /fail[\s\S]*not roll[\s\S]*no store commit/i,
    /unawaited[\s\S]*cancel/i,
    /no nested codemode/i,
    /max_output_tokens[\s\S]*not[\s\S]*caps/i,
    /\[Manual\]\(\/opt\/pi-orb\/skills\/codemode-manual\/SKILL\.md\)/,
    /\/opt\/pi-orb\/skills\/codemode-manual\/SKILL\.md/,
  ])
    expect(content).toMatch(requirement);
});

it.each([
  ["process", "/workspace/repo"],
  ["docker", "/guest/repo"],
  ["gcp", "/workspace"],
])(
  "reads reciprocal skill links from the %s cwd-independent resource snapshot",
  async (_provider, cwd) => {
    const bundle = await codemodeBundle();
    const reader = new SnapshotResourceReader(bundle);
    const skillPath = "/opt/pi-orb/skills/codemode-quick-reference/SKILL.md";
    const skill = Buffer.from((await reader.read(skillPath))._unsafeUnwrap()).toString();
    expect(skill).toContain("[Manual](/opt/pi-orb/skills/codemode-manual/SKILL.md)");
    expect(skill).toContain("/opt/pi-orb/skills/codemode-manual/SKILL.md");
    expect(skill).not.toMatch(/\/app\/|package root|paths may differ|models/i);
    const manualPath = skill.match(/\[Manual\]\(([^)]+)\)/)?.[1] ?? "missing";
    const manual = Buffer.from((await reader.read(manualPath))._unsafeUnwrap()).toString();
    for (const api of [
      "@options:",
      "ALL_TOOLS",
      "searchTools",
      "describeTool",
      "describeNamespace",
      "structuredContent",
      "exit_code",
      "full_output_path",
      "store(",
      "load(",
      "resource_limit",
    ])
      expect(manual).toContain(api);
    expect(manual.length).toBeGreaterThan(2000);
    expect(manual).not.toMatch(/models\.|settings\.md|CodemodeSandbox/);
    const resources = snapshotPromptResources(bundle)._unsafeUnwrap();
    const prompt = renderPrompt({ cwd, repository: [], skills: resources.skills });
    expect(resources.skills.filter(({ name }) => name.startsWith("codemode-"))).toHaveLength(2);
    const limitsPath = manual.match(/\[Limits \(central wrapper\)\]\(([^)]+)\)/)?.[1] ?? "missing";
    expect(limitsPath).toBe(skillPath);
    expect(Buffer.from((await reader.read(limitsPath))._unsafeUnwrap()).toString()).toBe(skill);
    expect(manual).toContain("# Code-mode agent manual");
    expect(manual).toContain("MIT License");
    expect(manual).toContain("Copyright (c) 2025 Mario Zechner");
    expect(manual).not.toMatch(/SKILL\.md#|\/app\//);
    expect(prompt).not.toContain(manual);
    expect(prompt).not.toContain("structuredContent");
  },
);
