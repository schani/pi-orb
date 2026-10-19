import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
function ordered(text: string, fragments: string[]) {
  let offset = -1;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, offset + 1);
    assert.ok(index > offset, `Missing/out of order: ${fragment}`);
    offset = index;
  }
}

test("checkout composition: section declarations and model tool description stay separate", async () => {
  const adapter = await source("apps/control-plane/src/adapters/durable/tools/codemode.ts");
  assert.match(adapter, /native\.description\.replace\(/);
  assert.match(adapter, /\) \+ POLICY/);
  assert.match(adapter, /Images are returned inline/);
  const extension = adapter.slice(adapter.indexOf("export function codemodeExtension"));
  ordered(extension, [
    "createCodemodeExtension(",
    "tools: [codemodeTool(",
    "sections:",
    "section.render(input, context)",
    "namespaceValues()",
    "namespace.instructions",
  ]);
  const native = await source("node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js");
  assert.match(native, /description: codemodeDescription\(options.models/);
  assert.match(native, /codemodeSection\(/);
  const describe = await source(
    "node_modules/@earendil-works/pi-durable/dist/codemode/describe.js",
  );
  ordered(describe.slice(describe.indexOf("export function codemodeSection")), [
    "a.namespace.name.localeCompare(b.namespace.name)",
    "selectCatalog(",
    "namespace.description",
    "toolSections.push(",
  ]);
});

test("checkout instruction order and native Claude append remain source-backed", async () => {
  const pi = await source("apps/control-plane/src/adapters/durable/prompt.ts");
  ordered(pi.slice(pi.indexOf("export function renderPrompt")), [
    "snapshot.personal",
    "snapshot.repository.map",
    "snapshot.project",
    "return [",
    "You are a coding assistant",
    "<project_instructions>",
    "snapshot.appendSystem",
    "environmentPrompt",
    "piEnvironmentPrompt",
    "formatSkillsForPrompt",
  ]);
  assert.match(pi, /formatSkillsForPrompt\(\[\.\.\.snapshot\.skills\]\)/);
  const process = await source("apps/control-plane/src/process-agent-composition.ts");
  ordered(process.slice(process.indexOf("const instructions = renderPrompt")), [
    "personal:",
    "project:",
    "repository: prepared.value.instructions",
    "skills: prepared.value.skills",
    "appendSystem: processAgentSystemContext(orb.userTimeZone)",
  ]);
  assert.doesNotMatch(pi, /<cwd>|InstructionReadiness/);
  assert.doesNotMatch(process, /InstructionReadiness|pendingInstructions|APPEND_SYSTEM/);
  assert.match(pi, /parent started you in this same orb; you share its filesystem/);
  assert.match(pi, /Do not use \\`orb_send\\` for that/);
  assert.match(pi, /Do not start subagents or orbs/);
  const claude = await source("apps/orb-runtime/src/claude/agent.ts");
  ordered(claude.slice(claude.indexOf("this.prompt = [")), [
    "environmentPrompt",
    "claudeEnvironmentPrompt",
    "personal.value.content",
    "project.value.content",
    "this.options.previewHost",
    "context.value.userTimeZone",
    "User's time zone:",
  ]);
  const skills = await source("node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js");
  ordered(skills.slice(skills.indexOf("export function formatSkillsForPrompt")), [
    "disableModelInvocation",
    "specialized instructions",
    'fileReadTool === "read"',
    "relative path",
    "<available_skills>",
    "<name>",
    "<description>",
    "<location>",
  ]);
});

test("central caller filters and section registration match the template", async () => {
  const tools = await source("apps/control-plane/src/adapters/durable/tools/index.ts");
  assert.match(tools, /const catalog = all\.without\(\["notify_parent"\]\)/);
  assert.match(
    tools,
    /const child = all\.without\(\[\.\.\.subagentTools\.map\(\(tool\) => tool\.name\), "orb_spawn", "orb_alert"\]\)/,
  );
  const process = await source("apps/control-plane/src/process-agent-composition.ts");
  ordered(process.slice(process.indexOf("const installTools =")), [
    "tools.extension",
    "tools.childExtension",
    "installTools();",
    "return ok({",
    "registry,",
  ]);
  const agent = await source("apps/control-plane/src/adapters/durable/agent.ts");
  ordered(agent.slice(agent.indexOf("static open(")), [
    "registry.install(promptExtension(",
    "Harness.open(",
  ]);
  const native = await source("node_modules/@earendil-works/pi-durable/dist/harness/prompt.js");
  assert.match(native, /<\$\{section.key\}>/);
});

test("MCP tools are deferred; discovery guides retain namespace registration order", async () => {
  const catalog = await source("apps/control-plane/src/adapters/durable/tools/catalog.ts");
  assert.match(catalog, /this\.namespaces\.set\(value\.name, value\)/);
  assert.match(catalog, /return \[\.\.\.this\.namespaces\.values\(\)\]/);
  assert.match(catalog, /if \(tool\.name\.startsWith\("orb_"\)\)/);
  assert.match(catalog, /metadata\.deferred \? \{ deferred: true as const \}/);
  const mcp = await source("apps/control-plane/src/adapters/durable/tools/mcp.ts");
  ordered(mcp.slice(mcp.indexOf("async discover(")), [
    "for (const endpoint of this.endpoints)",
    "this.catalog.namespace(namespace)",
    "if (discovered.value.resources)",
    "this.registerResources()",
    "for (const tool of discovered.value.tools)",
    "deferred: true",
  ]);
  assert.match(
    mcp.slice(mcp.indexOf("private registerResources"), mcp.indexOf("private closed")),
    /deferred: true/,
  );
  const native = await source("node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js");
  assert.match(
    native,
    /codemodeSection\([\s\S]*?input\.agent\.callable\.filter\([\s\S]*?tool\.deferred !== true/,
  );
});

async function editorComposition() {
  const app = await source("scripts/prompt-browser/app.js");
  const pure = app.slice(
    app.indexOf("export function promptDelivery"),
    app.indexOf("const token ="),
  );
  return import(`data:text/javascript;base64,${Buffer.from(pure).toString("base64")}`);
}

async function checkoutEntries() {
  const { CATALOG } = await import("./catalog.ts");
  const { SourceAdapter } = await import("./source.ts");
  const adapter = new SourceAdapter(new URL("../../", import.meta.url).pathname);
  return Promise.all(
    CATALOG.map(async (definition) => (await adapter.read(definition))._unsafeUnwrap()),
  );
}

test("main initial catalogue includes native introduction and namespace guides, separate from model description", async () => {
  const entries = await checkoutEntries();
  const { composeInitialContext, promptDelivery } = await editorComposition();
  for (const role of ["root", "subagent"]) {
    const sections = composeInitialContext(entries, { harness: "pi", role });
    const system = sections.filter((s: { channel: string }) => s.channel === "system");
    assert.deepEqual(
      system.map((s: { title: string }) => s.title),
      ["Tool catalogue", "orb-instructions"],
    );
    const catalogue = system[0].parts.map((p: { text: string }) => p.text).join("");
    assert.match(catalogue, /^<codemode>\nTools scripts can call/);
    assert.match(catalogue, /Namespace orb: discover with describeNamespace\("orb"\)/);
    assert.match(catalogue, /Use archive\/delete only on explicit user request/);
    assert.match(catalogue, /<\/codemode>$/);
    const parts = system.flatMap((s: { parts: { id?: string; text: string }[] }) => s.parts);
    for (const id of [
      "namespace/orb-description",
      "namespace/orb-instructions",
      "system/preamble",
      "system/codemode",
    ])
      assert.equal(parts.filter((p: { id?: string }) => p.id === id).length, 1, id);
    for (const id of [
      "namespace/mcp-description",
      "namespace/mcp-instructions",
      "codemode/policy",
      "codemode/inline-images",
      "skill/codemode-manual/body",
    ])
      assert.ok(!parts.some((p: { id?: string }) => p.id === id), id);
    const parent = system[1].parts
      .filter((p: { id?: string }) => p.id)
      .map((p: { id?: string }) => p.id);
    assert.ok(parent.indexOf("system/environment") > parent.indexOf("system/timezone"));
    assert.ok(parent.indexOf("system/environment-pi") > parent.indexOf("system/environment"));
    for (const name of [
      "boot-hooks",
      "charts",
      "cloud-identity",
      "codemode-manual",
      "codemode-quick-reference",
      "hosting",
    ])
      assert.equal(
        parts.filter((p: { id?: string }) => p.id === `skill/${name}/description`).length,
        1,
      );
    const description = sections
      .find((s: { title: string }) => s.title === "functions.codemode · description")
      .parts.map((p: { text: string }) => p.text)
      .join("");
    const { createDurableTools } = await import(
      "../../apps/control-plane/src/adapters/durable/tools/index.ts"
    );
    const bundle = createDurableTools();
    assert.equal(description, bundle.modelTools[0].description);
    assert.match(description, /Images are returned inline/);
    assert.doesNotMatch(description, /also saves the image/);
  }
  assert.match(
    promptDelivery(entries.find((e) => e.id === "namespace/orb-instructions")),
    /first Pi model request/,
  );
  assert.match(
    promptDelivery(entries.find((e) => e.id === "namespace/mcp-instructions")),
    /when registered/,
  );
});

test("native catalogue retains intro, callable schemas and namespace descriptions", async () => {
  const { codemodeSection } = await import(
    "../../node_modules/@earendil-works/pi-durable/dist/codemode/describe.js"
  );
  const native = codemodeSection(
    [
      {
        name: "read",
        description: "Read text.",
        execute: async () => ({ output: [] }),
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path" } },
          required: ["path"],
        },
      },
      {
        name: "orb_self",
        description: "Identity.",
        execute: async () => ({ output: [] }),
        parameters: { type: "object", properties: {} },
        structuredOutputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
    [{ name: "orb", prefix: "orb_", description: "Orb lifecycle" }],
    3000,
  );
  assert.match(native ?? "", /^Tools scripts can call/);
  assert.match(native ?? "", /read\(args: \{/);
  assert.match(native ?? "", /path: string/);
  assert.match(native ?? "", /## orb\nOrb lifecycle/);
  assert.match(native ?? "", /Promise<\{ id: string; \}>/);
});
