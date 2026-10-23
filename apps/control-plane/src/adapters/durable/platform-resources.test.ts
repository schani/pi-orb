import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  CHART_MAX_BARS,
  CHART_MAX_PER_SCRIPT,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
} from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { SnapshotResourceReader } from "../../domain/resources.ts";
import { snapshotPromptResources } from "../git-resources/prompt.ts";
import { loadPlatformResources } from "./platform-resources.ts";
import { renderPrompt } from "./prompt.ts";
import { createAgentToolFiles } from "./tool-files.ts";
import { CODEMODE_BOOTSTRAP } from "./tools/codemode.ts";
import { createDurableTools } from "./tools/index.ts";
import { openCodemodeHarness } from "./tools/testkit/codemode.ts";

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
    "/opt/pi-orb/skills/charts/SKILL.md",
    "/opt/pi-orb/skills/cloud-identity/SKILL.md",
    "/opt/pi-orb/skills/codemode/SKILL.md",
    "/opt/pi-orb/skills/hosting/SKILL.md",
  ]);
  expect(loaded.every((file) => file.sha256.length === 64)).toBe(true);
  const reader = new SnapshotResourceReader({
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
    name: "codemode",
    description: "Code-mode scripting instructions. Read before using codemode.",
  },
];

it("discovers single skill metadata without bodies and reads snapshots on demand", async () => {
  const bundle = await codemodeBundle();
  const resources = snapshotPromptResources(bundle)._unsafeUnwrap();
  const prompt = renderPrompt({ repository: [], skills: resources.skills });
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
  expect(bundle.files.filter(({ path }) => path.endsWith("/codemode/SKILL.md"))).toHaveLength(1);
  expect(prompt).toContain("Load a skill's file when the task matches its description.");
  expect(prompt).not.toContain("Use the read tool");
  expect(prompt).not.toContain("262144");
  expect(prompt).not.toContain("structuredContent");
});

it("packages upstream attribution beside the skill without adding it to prompts", async () => {
  const bundle = await codemodeBundle();
  const reader = new SnapshotResourceReader(bundle);
  const license = Buffer.from(
    (await reader.read("/opt/pi-orb/skills/codemode/LICENSE"))._unsafeUnwrap(),
  ).toString();
  expect(license).toBe(
    await readFile(
      new URL("../../../../orb-runtime/skills/codemode/LICENSE", import.meta.url),
      "utf8",
    ),
  );
  expect(license).toMatch(/MIT License[\s\S]*Copyright \(c\) 2025 Mario Zechner/);
  expect(license).toContain("SOFTWARE.");
  expect(license).toContain(
    "https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable/src/codemode",
  );
  const skill = Buffer.from(
    (await reader.read("/opt/pi-orb/skills/codemode/SKILL.md"))._unsafeUnwrap(),
  ).toString();
  expect(skill).not.toContain("MIT License");
  expect(skill).not.toContain("## Provenance and license");
  const prompt = renderPrompt({
    repository: [],
    skills: snapshotPromptResources(bundle)._unsafeUnwrap().skills,
  });
  expect(prompt).not.toContain(license);
  expect(prompt).not.toContain("MIT License");
  expect(prompt).not.toContain("/opt/pi-orb/skills/codemode/LICENSE");
});

it("provides all scripting guidance and caps in one bounded skill", async () => {
  const bundle = await codemodeBundle();
  const file = bundle.files.find(({ path }) => path.endsWith("/codemode/SKILL.md"));
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
    /Images: PNG\/JPEG\/GIF\/WebP retain original bytes/i,
    /up to 20\s*MiB raw, inclusive, independent of dimensions/i,
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
    /ALL_TOOLS[\s\S]*describeNamespace/,
    /structuredContent[\s\S]*exit_code|exit_code[\s\S]*structuredContent/,
    /await chart\(spec\)[\s\S]*source[\s\S]*8 charts/,
    /Images are returned inline/,
    /Promise\.allSettled/,
    /<console_output>/,
    /each nested tool retains its own replay policy/,
    /Only codemode is offered to the model/,
    /The \x60tool-catalogue\x60 section of the system prompt lists/,
    /describeNamespace\("orb"\)/,
    /describeNamespace\("mcp"\)/,
    /exact namespace identifier[\s\S]*describeNamespace\("mcp__github"\)/i,
    /resource[\s\S]*\x60server\x60 argument[\s\S]*bare server name/i,
    /Before first using tools in a namespace[\s\S]*describeNamespace[\s\S]*instructions[\s\S]*follow[\s\S]*server instructions/i,
    /Use archive\/delete only on explicit user request\./,
    /Stop\/sleep revokes execution admission; a connected browser does not override Stop\./,
    /Use server names from MCP namespaces; list resources\/templates before reading unfamiliar URIs\./,
  ])
    expect(content).toMatch(requirement);
});

it.each([
  ["process", "/workspace/repo"],
  ["docker", "/guest/repo"],
  ["gcp", "/workspace"],
])(
  "executes the literal bootstrap against the complete %s cwd-independent snapshot",
  async (_provider, cwd) => {
    const bundle = await codemodeBundle();
    const reader = new SnapshotResourceReader(bundle);
    const read = vi.spyOn(reader, "read");
    const files = createAgentToolFiles({
      reader,
      allowSnapshotRead: () => false,
      check: () => okAsync(undefined),
      artifacts: { write: () => okAsync("unused"), read: () => okAsync(null) },
    });
    const tools = createDurableTools({ files });
    const env = new NodeExecutionEnv({ cwd });
    const guestRead = vi.spyOn(env, "openBinaryReader");
    const fixture = await openCodemodeHarness(tools.catalog, { files, env });
    try {
      const skillPath = "/opt/pi-orb/skills/codemode/SKILL.md";
      const file = bundle.files.find(({ path }) => path === skillPath);
      if (!file) return expect.fail("Canonical code-mode skill missing");
      const skill = await readFile(
        new URL("../../../../orb-runtime/skills/codemode/SKILL.md", import.meta.url),
        "utf8",
      );
      expect(Buffer.from(file.bytes).toString()).toBe(skill);
      expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(50 * 1024);
      expect(skill.split("\n").length).toBeLessThanOrEqual(2000);
      const result = await fixture.run(CODEMODE_BOOTSTRAP.split("\n").slice(1).join("\n"));
      expect(result.isError).toBe(false);
      const output = result.output?.filter((item) => item.type === "text").map((item) => item.text);
      expect(output).toHaveLength(2);
      expect(output?.[0]).toMatch(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/);
      expect(output?.[1]).toBe(skill);
      expect(result.diagnostics ?? []).toEqual([]);
      expect(read).toHaveBeenCalledExactlyOnceWith(skillPath);
      expect(guestRead).not.toHaveBeenCalled();
      expect(skill).not.toMatch(/codemode-manual|codemode-quick-reference|SKILL\.md#|models\./);
      expect(skill).not.toContain("MIT License");
    } finally {
      await fixture.close();
      await tools.close();
    }
  },
);

it("describes code-mode charts with the limits chart() enforces", async () => {
  const bundle = await codemodeBundle();
  const resources = snapshotPromptResources(bundle)._unsafeUnwrap();
  const skill = resources.skills.find((entry) => entry.name === "charts");
  expect(skill?.description).toMatch(/chart\(\)/);
  expect(skill?.description).toMatch(/code-mode/i);
  const content = Buffer.from(
    (
      await new SnapshotResourceReader(bundle).read("/opt/pi-orb/skills/charts/SKILL.md")
    )._unsafeUnwrap(),
  ).toString();
  for (const limit of [
    `${CHART_MAX_SERIES} series`,
    `${CHART_MAX_POINTS.toLocaleString("en-US")} points`,
    `${CHART_MAX_BARS} bars`,
    `${CHART_MAX_PER_SCRIPT} charts per script`,
  ])
    expect(content).toContain(limit);
  expect(content).toContain("await chart(");
});
