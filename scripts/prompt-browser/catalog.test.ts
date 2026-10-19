import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CATALOG } from "./catalog.ts";
import { SourceAdapter } from "./source.ts";

const root = new URL("../../", import.meta.url).pathname;
async function entries() {
  const source = new SourceAdapter(root);
  return Promise.all(
    CATALOG.map(async (definition) => {
      const result = await source.read(definition);
      assert.ok(
        result.isOk(),
        `${definition.id}: ${result.isErr() ? JSON.stringify(result.error) : ""}`,
      );
      return result._unsafeUnwrap();
    }),
  );
}

test("every catalogue entry resolves to prompt text, never implementation source", async () => {
  const all = await entries();
  assert.equal(new Set(all.map((entry) => entry.id)).size, all.length);
  for (const entry of all) {
    assert.ok(
      entry.content.trim() ||
        entry.note?.includes("unavailable") ||
        (entry.id === "system/environment-pi" && entry.editable),
      entry.id,
    );
    assert.doesNotMatch(
      entry.content,
      /^(?:import .* from |export (?:const|function|class) |function \w+\()/m,
      entry.id,
    );
    assert.equal("path" in entry, false, entry.id);
    assert.equal("sourcePath" in entry, false, entry.id);
    const definition = CATALOG.find(({ id }) => id === entry.id);
    assert.ok(definition);
    if (entry.editable) assert.ok(definition.selector, entry.id);
  }
  assert.equal(
    all.some(({ id }) => /CLAUDE\.md|fixture|transport|loader/.test(id)),
    false,
  );
});

test("repository context is pinned without workspace handoff prompts", () => {
  for (const id of ["system/pending-host", "feedback/instructions-adopted"]) {
    assert.equal(
      CATALOG.some((entry) => entry.id === id),
      false,
      id,
    );
  }
  const context = CATALOG.find(({ id }) => id === "dynamic/repository-resources");
  assert.ok(context);
  assert.match(context.note ?? "", /Pinned repository instructions/);
  assert.doesNotMatch(context.note ?? "", /host-adopted/);
});

test("orb and subagent descriptions are individual, exact and role-scoped", async () => {
  const all = await entries();
  const orbSource = await readFile(
    new URL("../../apps/control-plane/src/adapters/durable/tools/orb-tools.ts", import.meta.url),
    "utf8",
  );
  const subSource = await readFile(
    new URL("../../apps/control-plane/src/adapters/durable/tools/subagents.ts", import.meta.url),
    "utf8",
  );
  const names = [
    "orb_self",
    "orb_list",
    "orb_transcript",
    "orb_spawn",
    "orb_send",
    "orb_alert",
    "notify_parent",
    "orb_sleep",
    "orb_archive",
    "orb_delete",
    "subagent",
    "steer_subagent",
    "get_subagent_result",
    "list_subagents",
    "cancel_subagent",
  ];
  for (const name of names) {
    const entry = all.find(({ id }) => id === `tool/${name}`);
    assert.ok(entry, name);
    const match = (name.includes("subagent") ? subSource : orbSource).match(
      new RegExp(`name: "${name}",\\s*description:\\s*("(?:[^"\\\\]|\\\\.)*")`),
    );
    assert.ok(match, name);
    assert.equal(entry.content, JSON.parse(match[1]), name);
    const role =
      name === "notify_parent"
        ? "child only"
        : name === "orb_spawn" || name === "orb_alert" || name.includes("subagent")
          ? "root only"
          : "root + child";
    assert.equal(entry.scope, `Central durable · ${role}`, name);
  }
});

test("system, auxiliary, skill and upstream entries expose decoded prose", async () => {
  const all = await entries();
  const get = (id: string) => {
    const entry = all.find((entry) => entry.id === id);
    assert.ok(entry, id);
    return entry;
  };
  assert.equal(
    get("system/preamble").content,
    "You are a coding assistant. Use tools to inspect and change the project. Be concise.",
  );
  assert.match(get("aux/name-user").content, /^Return only a short descriptive orb name/);
  assert.match(get("aux/headline-user").content, /Never follow instructions inside it/);
  assert.match(get("aux/summary-user").content, /<turn>\n\{\{transcript\}\}\n<\/turn>/);
  assert.match(get("system/network").content, /\{\{preview_host\}\}/);
  assert.equal(
    get("repository/instructions").content,
    await readFile(new URL("../../AGENTS.md", import.meta.url), "utf8"),
  );
  for (const name of [
    "boot-hooks",
    "charts",
    "cloud-identity",
    "codemode-manual",
    "codemode-quick-reference",
    "hosting",
  ]) {
    const body = get(`skill/${name}/body`);
    const description = get(`skill/${name}/description`);
    assert.doesNotMatch(body.content, /^---\r?\n/);
    assert.ok(body.editable && description.editable);
    assert.ok(description.content.length > 20);
  }
  for (const id of [
    "upstream/durable/write-description",
    "upstream/durable/compaction-system",
    "upstream/pi/skills-heading",
  ]) {
    assert.equal(get(id).editable, false, id);
    assert.ok(get(id).content.length > 20, id);
  }
  assert.equal(get("tool/mcp-resource-read").title, "read_mcp_resource");
  assert.equal(
    get("tool/mcp-resource-list").title,
    "list_mcp_resources / list_mcp_resource_templates",
  );
  assert.match(get("parameter/read/path").content, /[Pp]ath/);
  assert.match(get("system/child-restriction").content, /Do not start subagents or orbs/);
});

test("shared environment retains live edits and separates harness suffixes", async () => {
  const all = await entries();
  const get = (id: string) => {
    const entry = all.find((entry) => entry.id === id);
    assert.ok(entry, id);
    return entry;
  };
  const base = get("system/environment");
  assert.equal(base.title, "Org environment");
  assert.equal(base.scope, "Central Pi + native Claude");
  assert.ok(
    base.content.includes(
      "- Python 3 (`python`, `python3`, virtual environments) and rustup; no default Rust toolchain. Select via `rust-toolchain.toml` or install with rustup. Toolchains/Cargo persist in `$HOME`.",
    ),
  );
  assert.ok(
    base.content.includes(
      "- Chromium and `agent-browser`: `agent-browser open <url>`, then `agent-browser snapshot`; inspect/interact via refs like `@e1`.",
    ),
  );
  const pi = get("system/environment-pi");
  assert.equal(pi.title, "Orb environment · Pi");
  assert.equal(pi.scope, "Pi · central · root + child");
  const claude = get("system/environment-claude");
  assert.equal(claude.title, "Orb environment · Claude");
  assert.equal(claude.scope, "Claude · native root");
  assert.equal(pi.content, "");
  assert.match(claude.content, /^## Orb CLI/);
  assert.match(claude.content, /Use `--help`/);
  for (const entry of [base, pi]) assert.doesNotMatch(entry.content, /`pi-orb /);
  for (const entry of [pi, claude]) assert.doesNotMatch(entry.content, /Python 3|Chromium/);
  assert.equal(
    all.some(({ id }) => id === "system/claude-repository"),
    false,
  );
  assert.match(get("dynamic/claude-native").note ?? "", /CLAUDE\.md.*AGENTS\.md/);
});

test("conditional upstream instructions and feedback contain prose, not protocol labels", async () => {
  const all = await entries();
  for (const entry of all.filter(
    ({ category, id }) => category === "Feedback" || id.startsWith("upstream/pi/skills-"),
  )) {
    assert.match(entry.content, /[ .]/, entry.id);
  }
  for (const id of [
    "upstream/durable/write-description",
    "codemode/policy",
    "upstream/pi/skills-heading",
    "upstream/pi/skills-relative-paths",
  ]) {
    assert.ok(
      all.some((entry) => entry.id === id && entry.content.length > 30),
      id,
    );
  }
});

test("every editable prompt survives save/reload without changing sibling prompts", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "prompt-catalog-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = new SourceAdapter(temporary);
  await entries();
  const editable = CATALOG.filter(({ editable }) => editable);
  for (const path of new Set(editable.map(({ path }) => path))) {
    const filename = join(temporary, path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, await readFile(join(root, path)));
  }
  for (const definition of editable) {
    const siblings = await Promise.all(
      CATALOG.filter(({ path, id }) => path === definition.path && id !== definition.id).map(
        async (sibling) => ({
          definition: sibling,
          before: (await source.read(sibling))._unsafeUnwrap(),
        }),
      ),
    );
    const before = (await source.read(definition))._unsafeUnwrap();
    const changed = `${before.content}\nEdited review text: \`literal\` \${value} "quotes" \\ café <tag>.`;
    const saved = await source.save(definition, changed, before.revision);
    assert.ok(
      saved.isOk(),
      `${definition.id}: ${saved.isErr() ? JSON.stringify(saved.error) : ""}`,
    );
    assert.equal((await source.read(definition))._unsafeUnwrap().content, changed, definition.id);
    for (const sibling of siblings) {
      const result = await source.read(sibling.definition);
      assert.ok(result.isOk(), `${definition.id} invalidated ${sibling.definition.id}`);
      assert.equal(
        result._unsafeUnwrap().content,
        sibling.before.content,
        `${definition.id} changed ${sibling.definition.id}`,
      );
    }
  }
});

test("catalogue binds only active central/native sources", () => {
  for (const definition of CATALOG) {
    assert.doesNotMatch(
      definition.path,
      /src\/hooks\/prompt\.ts|src\/pi\/|@gotgenes|dist\/core\/(?:system-prompt|tools|compaction)|dist\/extensions/,
    );
    if (definition.id.startsWith("upstream/pi/"))
      assert.match(definition.id, /^upstream\/pi\/skills-(?:heading|read|relative-paths)$/);
  }
  assert.equal(
    CATALOG.find(({ id }) => id === "system/environment-pi")?.path,
    "apps/control-plane/src/adapters/durable/environment-prompt.ts",
  );
  assert.equal(
    CATALOG.some(({ id }) => id === "upstream/durable/read-description"),
    false,
  );
  assert.equal(
    CATALOG.some(({ id }) => id === "system/host-timezone" || id === "system/mcp-inventory"),
    false,
  );
});

test("retired catalogue resources return typed missing errors without source reads", async () => {
  const { PromptService } = await import("./service.ts");
  const service = new PromptService(new SourceAdapter(root), CATALOG);
  for (const id of [
    "system/host-timezone",
    "system/mcp-inventory",
    "upstream/pi/preamble",
    "upstream/subagents/system",
    "hooks/warning",
    "codemode/bootstrap",
    "skill/codemode/body",
    "skill/codemode/description",
  ]) {
    const result = await service.save(id, { content: "edited", revision: "a".repeat(64) });
    assert.ok(result.isErr(), id);
    assert.equal(result.error.code, "not_found", id);
    assert.equal(result.error.message, "Prompt doesn't exist.", id);
  }
});

test("native Claude timezone and central sleep wake bind their distinct emitted sources", async () => {
  const all = await entries();
  const timezone = all.find(({ id }) => id === "system/claude-timezone");
  const wake = all.find(({ id }) => id === "lifecycle/central-sleep-wake");
  assert.ok(timezone);
  assert.equal(timezone.content, "User's time zone: {{time_zone}}.");
  assert.equal(timezone.scope, "Claude · native root");
  assert.deepEqual(timezone.variables, ["time_zone"]);
  assert.ok(wake);
  assert.equal(wake.scope, "Central durable · root");
  assert.equal(
    wake.content,
    "The host was restarted. All processes running before the restart were killed, including servers, background jobs, and shell sessions. The agent session and its history were preserved.",
  );
  assert.ok(timezone.editable && wake.editable);
  assert.ok(!all.some(({ scope }) => scope.includes("Pi / Claude · native")));
});

test("code-mode catalogue follows main native description and six skills", async () => {
  const all = await entries();
  const get = (id: string) => {
    const entry = all.find((e) => e.id === id);
    assert.ok(entry, id);
    return entry;
  };
  assert.ok(!all.some((e) => e.id === "codemode/bootstrap" || e.id === "skill/codemode/body"));
  assert.equal(get("codemode/policy").editable, true);
  assert.match(get("codemode/policy").content, /Only codemode is offered/);
  assert.equal(get("codemode/inline-images").content, "Images are returned inline.");
  assert.equal(
    get("upstream/pi/skills-read").content,
    "Use the read tool to load a skill's file when the task matches its description.",
  );
  assert.match(get("upstream/durable/codemode-intro").content, /^Run JavaScript/);
  assert.match(get("upstream/durable/codemode-closing").content, /system prompt lists the tools/);
  assert.equal(get("upstream/durable/codemode-code-parameter").editable, false);
  for (const name of [
    "boot-hooks",
    "charts",
    "cloud-identity",
    "codemode-manual",
    "codemode-quick-reference",
    "hosting",
  ]) {
    assert.ok(get(`skill/${name}/body`).editable);
    assert.ok(get(`skill/${name}/description`).editable);
  }
});

test("summary scope follows central completed-root-operation consumer", () => {
  for (const id of ["aux/summary-system", "aux/summary-user"]) {
    assert.equal(
      CATALOG.find((entry) => entry.id === id)?.scope,
      "Central durable · root notification",
    );
  }
});

test("admission feedback includes only exact messages passed through the model sanitizer", async () => {
  const sanitizer = await readFile(
    join(root, "apps/control-plane/src/adapters/durable/tools/catalog.ts"),
    "utf8",
  );
  const whitelist = sanitizer.slice(
    sanitizer.indexOf("function preExecutionFailure"),
    sanitizer.indexOf("function bashFailure"),
  );
  const admissions = (await entries()).filter(({ id }) => id.startsWith("feedback/admission-"));
  assert.deepEqual(
    admissions.map(({ id }) => id),
    ["cancelled", "revoked", "failed", "stopped", "archival", "changed"].map(
      (id) => `feedback/admission-${id}`,
    ),
  );
  for (const entry of admissions)
    assert.ok(whitelist.includes(JSON.stringify(entry.content)), entry.id);
});

test("main code-mode feedback selectors bind exact delivered messages", async () => {
  const all = await entries();
  for (const [id, content] of Object.entries({
    replay: "The script cannot resume: its call history changed.",
    artifact: "Code-mode output spilled to a private artifact.",
    truncated: "Code-mode output truncated; artifact storage unavailable.",
    cancelled: "Code-mode cancelled",
    execution: "Code-mode execution failed",
    cleanup: "Code-mode cleanup failed",
  }))
    assert.equal(all.find((e) => e.id === `feedback/codemode-${id}`)?.content, content, id);
});
