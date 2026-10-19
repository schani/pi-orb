import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  section,
} from "@earendil-works/pi-durable";
import { errAsync } from "neverthrow";
import { loadPlatformResources } from "../../apps/control-plane/src/adapters/durable/platform-resources.ts";
import {
  promptExtension,
  renderPrompt,
} from "../../apps/control-plane/src/adapters/durable/prompt.ts";
import { createDurableTools } from "../../apps/control-plane/src/adapters/durable/tools/index.ts";
import { createOrbTools } from "../../apps/control-plane/src/adapters/durable/tools/orb-tools.ts";
import { snapshotPromptResources } from "../../apps/control-plane/src/adapters/git-resources/prompt.ts";
import { CATALOG } from "./catalog.ts";
import { renderInitialSystem } from "./render.ts";
import { PromptService } from "./service.ts";
import { SourceAdapter } from "./source.ts";
import type { Entry } from "./types.ts";

const root = new URL("../../", import.meta.url).pathname;
const source = new SourceAdapter(root);
const service = new PromptService(source, CATALOG);
const input = { harness: "pi", role: "root", timeZone: "America/Los_Angeles", drafts: [] };
async function entries() {
  return (await service.list())._unsafeUnwrap();
}
async function production(
  role: "root" | "subagent",
  timeZone: string | null,
  patches: Readonly<Record<string, string>> = {},
  capture?: { description?: string },
) {
  const platform = (await loadPlatformResources(root + "apps/orb-runtime/skills"))._unsafeUnwrap();
  const skills = snapshotPromptResources({
    orbId: "local",
    commitSha: "local",
    instructionPath: null,
    skillRoot: "/opt/pi-orb/skills",
    files: platform,
  })._unsafeUnwrap().skills;
  const prompt = renderPrompt(
    {
      personal: "",
      project: "",
      repository: [
        {
          path: "AGENTS.md",
          content:
            patches["repository/instructions"] ?? (await readFile(root + "AGENTS.md", "utf8")),
        },
      ],
      skills: skills.map((skill) => ({
        ...skill,
        description: patches[`skill/${skill.name}/description`] ?? skill.description,
      })),
      appendSystem: [
        patches["system/codemode"] ?? "Use codemode to compose tool calls.",
        ...(timeZone
          ? [
              patches["system/timezone"] === undefined
                ? `User’s time zone: ${timeZone}. Present dates and times in this time zone unless they request another.`
                : `TZ ${timeZone} END`,
            ]
          : []),
      ].join("\n\n"),
    },
    {
      ...(patches["system/preamble"] !== undefined ? { preamble: patches["system/preamble"] } : {}),
      ...(patches["system/environment"] !== undefined
        ? { environment: patches["system/environment"] }
        : {}),
      ...(patches["system/environment-pi"] !== undefined
        ? { piEnvironment: patches["system/environment-pi"] }
        : {}),
    },
  );
  const bundle = createDurableTools({
    additionalTools: createOrbTools({
      invoke: () => errAsync({ code: "unavailable", message: "Not executable" }),
    }),
  });
  const policyDefinition = CATALOG.find((d) => d.id === "codemode/policy");
  const inlineDefinition = CATALOG.find((d) => d.id === "codemode/inline-images");
  assert.ok(policyDefinition && inlineDefinition);
  const policy = (await source.read(policyDefinition))._unsafeUnwrap().content;
  const inline = (await source.read(inlineDefinition))._unsafeUnwrap().content;
  const description =
    bundle.modelTools[0].description
      .slice(0, -policy.length)
      .replace(inline, patches["codemode/inline-images"] ?? inline) +
    (patches["codemode/policy"] ?? policy);
  const childTools =
    bundle.childExtension.tools?.map((tool) =>
      tool.name === "codemode" ? { ...tool, description } : tool,
    ) ?? [];
  const registry = createRegistry();
  // Match process-agent-composition's installation and DurableAgent/ChildAnchor's role selection.
  for (const extension of [bundle.extension, bundle.childExtension]) {
    registry.install(
      defineExtension({
        ...extension,
        tools:
          extension.tools?.map((tool) => {
            if (tool.name === "codemode") return { ...tool, description };
            if (tool.name !== "read") return tool;
            const { properties } = tool.parameters as {
              properties: { path: { description?: string } };
            };
            return {
              ...tool,
              description: patches["tool/read"] ?? tool.description,
              ...(patches["parameter/read/path"] && properties
                ? {
                    parameters: {
                      ...tool.parameters,
                      properties: {
                        ...properties,
                        path: { ...properties.path, description: patches["parameter/read/path"] },
                      },
                    },
                  }
                : {}),
            };
          }) ?? [],
      }),
    );
  }
  const namespace = bundle.catalog.namespaceValues().find((ns) => ns.name === "orb");
  assert.ok(namespace);
  bundle.catalog.namespace({
    ...namespace,
    description: patches["namespace/orb-description"] ?? namespace.description,
    instructions: patches["namespace/orb-instructions"] ?? namespace.instructions,
  });
  const nativePrompt = promptExtension(prompt);
  registry.install(
    patches["system/child-restriction"] === undefined
      ? nativePrompt
      : // This fixture supplies the edited child text as data; do not run the unedited refresh hook.
        defineExtension({
          ...nativePrompt,
          hooks: [],
          sections: [
            section("orb-instructions", ({ conversationId }) =>
              conversationId === ROOT_CONVERSATION_ID ? prompt : `${prompt}\nCHILD_DRAFT`,
            ),
          ],
        }),
  );
  const faux = fauxProvider();
  let captured = "";
  faux.setResponses([
    (context) => {
      captured = getCurrentSystemPrompt(context.messages);
      if (capture)
        capture.description =
          getCurrentTools(context.messages).find((tool) => tool.name === "codemode")?.description ??
          "MISSING";
      return fauxAssistantMessage("done");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const agent = {
      model: { provider: "faux", modelId: "faux-1" },
      extensions: { remove: [role === "root" ? bundle.childExtension : bundle.extension] },
      ...(role === "subagent"
        ? {
            tools: childTools,
            modelTools: childTools.filter((tool) => tool.name === "codemode"),
          }
        : {}),
    };
    const conversation =
      role === "root"
        ? await harness.root(BACKGROUND_CONTEXT, { agent })
        : await harness.createConversation(
            { ownership: { kind: "ownerless" }, agent },
            BACKGROUND_CONTEXT,
          );
    await (
      await conversation.submit({ type: "input", content: "capture" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    assert.equal(faux.state.callCount, 1);
    assert.ok(captured);
    return captured;
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await bundle.close();
  }
}

test("root and child SYSTEM bytes equal a real production Harness initial fake-model request", async () => {
  const all = await entries();
  for (const role of ["root", "subagent"] as const) {
    for (const timeZone of ["America/Los_Angeles", null]) {
      const rendered = (await service.render({ ...input, role, timeZone }))._unsafeUnwrap();
      assert.equal(rendered.text, await production(role, timeZone));
      assert.match(rendered.text, /^<codemode>\n/);
      assert.ok(rendered.text.includes("Tools scripts can call (`await tools.<name>(args)`):"));
      assert.match(rendered.text, /Namespace orb: discover with describeNamespace\("orb"\)/);
      assert.match(rendered.text, /Use archive\/delete only on explicit user request/);
      assert.match(rendered.text, /declare const tools:/);
      assert.ok(
        rendered.text.includes(
          `<orb-instructions>\n${all.find((e) => e.id === "system/preamble")?.content}\n\n<project_instructions>`,
        ),
      );
      assert.doesNotMatch(
        rendered.text,
        /{{time_zone}}|{{parent_instructions}}|Read the code-mode skill before/,
      );
    }
  }
});

test("all initial draft classes compose together; noninitial drafts never leak or execute", async () => {
  const all = await entries();
  const patches: Record<string, string> = {
    "system/preamble": "PREAMBLE_DRAFT",
    "system/environment": "ENVIRONMENT_DRAFT",
    "system/environment-pi": "PI_ENVIRONMENT_DRAFT",
    "system/codemode": "COMPOSE_DRAFT",
    "system/timezone": "TZ {{time_zone}} END",
    "system/child-restriction": "{{parent_instructions}}\nCHILD_DRAFT",
    "repository/instructions": "REPOSITORY_DRAFT",
    "skill/charts/description": "A <chart> & draft",
    "tool/read": "READ_DRAFT",
    "namespace/orb-description": "ORB_NAMESPACE_DRAFT",
    "namespace/orb-instructions": "ORB_INSTRUCTIONS_DRAFT",
    "skill/codemode-manual/body": "NEVER_INITIAL_SKILL_BODY",
    "codemode/policy": "NEVER_INITIAL_POLICY",
    "aux/name-system": "NEVER_INITIAL_AUX",
  };
  const drafts = all
    .filter((e) => e.id in patches)
    .map((e) => ({
      id: e.id,
      content: patches[e.id],
      revision: e.revision,
    }));
  const rendered = (await service.render({ ...input, role: "subagent", drafts }))._unsafeUnwrap()
    .text;
  for (const marker of [
    "PREAMBLE_DRAFT",
    "ENVIRONMENT_DRAFT",
    "PI_ENVIRONMENT_DRAFT",
    "COMPOSE_DRAFT",
    "TZ America/Los_Angeles END",
    "CHILD_DRAFT",
    "REPOSITORY_DRAFT",
    "READ_DRAFT",
    "ORB_NAMESPACE_DRAFT",
    "ORB_INSTRUCTIONS_DRAFT",
    "A &lt;chart&gt; &amp; draft",
  ])
    assert.ok(rendered.includes(marker), marker);
  assert.doesNotMatch(rendered, /NEVER_INITIAL|{{time_zone}}|{{parent_instructions}}/);
  assert.ok(rendered.includes("<orb-instructions>\nPREAMBLE_DRAFT\n\n<project_instructions>"));
  assert.equal(rendered, await production("subagent", "America/Los_Angeles", patches));
  assert.equal(
    (await service.list())._unsafeUnwrap().find((e) => e.id === "system/preamble")?.content,
    all.find((e) => e.id === "system/preamble")?.content,
  );
});

test("generated native schemas take current parameter descriptions without a duplicate schema table", async () => {
  const all = await entries();
  const modified: Entry[] = all.map((e) =>
    e.id === "parameter/read/path" ? { ...e, content: "PATH_DRAFT" } : e,
  );
  const snapshot = (await source.snapshot(CATALOG, []))._unsafeUnwrap();
  const result = await renderInitialSystem(
    { ...snapshot, entries: modified },
    { harness: "pi", role: "root", timeZone: null },
  );
  assert.match(result._unsafeUnwrap(), /\/\/ PATH_DRAFT\n\s*path: string/);
  assert.equal(
    result._unsafeUnwrap(),
    await production("root", null, { "parameter/read/path": "PATH_DRAFT" }),
  );
});

test("render rejects stale, unknown, duplicate, oversized, unsupported and protected-variable input", async () => {
  const all = await entries();
  const zone = all.find((e) => e.id === "system/timezone");
  assert.ok(zone);
  for (const [request, code] of [
    [{ ...input, harness: "claude" }, "unsupported"],
    [{ ...input, role: "unexpected" }, "invalid_request"],
    [{ ...input, timeZone: "Mars/Invalid" }, "invalid_request"],
    [{ ...input, path: "/etc/passwd" }, "invalid_request"],
    [
      { ...input, drafts: [{ id: "../AGENTS.md", content: "bad", revision: zone.revision }] },
      "not_found",
    ],
    [
      { ...input, drafts: [{ id: zone.id, content: zone.content, revision: "0".repeat(64) }] },
      "conflict",
    ],
    [
      { ...input, drafts: [{ id: zone.id, content: "no variable", revision: zone.revision }] },
      "invalid_request",
    ],
    [
      {
        ...input,
        drafts: [
          { id: zone.id, content: zone.content, revision: zone.revision },
          { id: zone.id, content: zone.content, revision: zone.revision },
        ],
      },
      "invalid_request",
    ],
    [
      {
        ...input,
        drafts: [{ id: zone.id, content: "x".repeat(1_048_577), revision: zone.revision }],
      },
      "too_large",
    ],
  ] as const) {
    const result = await service.render(request);
    assert.ok(result.isErr());
    assert.equal(result._unsafeUnwrapErr().code, code);
  }
});

test("production renderer accepts data-only prose overrides and preserves defaults", () => {
  const snapshot = { repository: [{ path: "AGENTS.md", content: "REPO" }], skills: [] };
  const baseline = renderPrompt(snapshot);
  assert.equal(renderPrompt(snapshot, {}), baseline);
  assert.equal(
    renderPrompt(snapshot, {
      preamble: "PREAMBLE",
      environment: "ENV",
      piEnvironment: "PI",
    }),
    "PREAMBLE\n\n<project_instructions>\n# AGENTS.md\nREPO\n</project_instructions>\n\nENV\n\nPI",
  );
});

test("empty instructions and simultaneous Unicode/HTML/whitespace/literal-brace drafts equal production in both roles and zones", async () => {
  const all = await entries();
  const cases: Readonly<Record<string, string>>[] = [
    {
      "repository/instructions": "",
      "system/preamble": "",
      "system/environment": "",
      "system/environment-pi": "",
    },
    {
      "repository/instructions": " \n<raw> café 🦊 {{literal}} & 'quotes'\r\n ",
      "system/preamble": "  PREAMBLE 🦊 <xml> {{literal}}  ",
      "system/environment": "\nENV & <markup> {{literal}}\n",
      "system/environment-pi": " \nPI\n ",
      "system/codemode": "COMPOSE_DRAFT",
      "system/timezone": "TZ {{time_zone}} END",
      "system/child-restriction": "{{parent_instructions}}\nCHILD_DRAFT",
      "tool/read": "READ_DRAFT 🦊 {{literal}}",
      "namespace/orb-description": "  NAMESPACE <raw> & 🦊  ",
      "skill/charts/description": "Charts <xml> & 🦊 {{literal}}",
      "skill/codemode-manual/body": "NEVER_INITIAL_SKILL_BODY",
      "codemode/policy": "NEVER_INITIAL_POLICY",
      "aux/name-system": "NEVER_INITIAL_AUX",
    },
  ];
  for (const patches of cases) {
    const drafts = all
      .filter((entry) => entry.id in patches)
      .map((entry) => ({
        id: entry.id,
        revision: entry.revision,
        content: patches[entry.id] ?? "",
      }));
    const snapshot = (await source.snapshot(CATALOG, drafts))._unsafeUnwrap();
    if (patches["tool/read"])
      snapshot.entries = snapshot.entries.map((entry) =>
        entry.id === "parameter/read/path"
          ? { ...entry, content: "PATH_DRAFT 🦊 <xml> {{literal}}" }
          : entry,
      );
    const expectedPatches = patches["tool/read"]
      ? { ...patches, "parameter/read/path": "PATH_DRAFT 🦊 <xml> {{literal}}" }
      : patches;
    for (const role of ["root", "subagent"] as const)
      for (const timeZone of [null, "America/Los_Angeles"]) {
        const result = await renderInitialSystem(snapshot, { harness: "pi", role, timeZone });
        assert.equal(result._unsafeUnwrap(), await production(role, timeZone, expectedPatches));
      }
  }
});

test("main default bytes/order/formatter stay unchanged with optional prose seam", async () => {
  const { environmentPrompt } = await import("../../apps/orb-runtime/src/environment-prompt.ts");
  const { formatSkillsForPrompt, createSyntheticSourceInfo } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const snapshot = {
    personal: "PERSONAL",
    repository: [{ path: "a", content: "REPO" }],
    project: "PROJECT",
    appendSystem: "APPEND",
    skills: [
      {
        name: "test",
        description: "TEST",
        filePath: "/test/SKILL.md",
        baseDir: "/test",
        sourceInfo: createSyntheticSourceInfo("/test/SKILL.md", { source: "test" }),
        disableModelInvocation: false,
      },
    ],
  };
  const expected = [
    "You are a coding assistant. Use tools to inspect and change the project. Be concise.",
    "<project_instructions>\nPERSONAL\n\n# a\nREPO\n\nPROJECT\n</project_instructions>",
    "APPEND",
    environmentPrompt,
    formatSkillsForPrompt(snapshot.skills),
  ].join("\n\n");
  assert.equal(renderPrompt(snapshot), expected);
  assert.equal(renderPrompt(snapshot, {}), expected);
  assert.equal(
    renderPrompt(snapshot, { preamble: "", environment: "", piEnvironment: "PI" }),
    [
      "<project_instructions>\nPERSONAL\n\n# a\nREPO\n\nPROJECT\n</project_instructions>",
      "APPEND",
      "PI",
      formatSkillsForPrompt(snapshot.skills),
    ].join("\n\n"),
  );
});

test("namespace description drafts preserve policy; instruction drafts equal independent Harness in both roles", async () => {
  const all = await entries();
  const cases: Readonly<Record<string, string>>[] = [
    { "namespace/orb-description": "DESCRIPTION_ONLY" },
    { "namespace/orb-instructions": "GUIDE_DRAFT" },
    {
      "namespace/orb-description": "DESCRIPTION_DRAFT",
      "namespace/orb-instructions": "GUIDE_DRAFT",
    },
  ];
  for (const patches of cases) {
    const drafts = all
      .filter((e) => e.id in patches)
      .map((e) => ({ id: e.id, revision: e.revision, content: patches[e.id] }));
    for (const role of ["root", "subagent"] as const) {
      const result = (await service.render({ ...input, role, drafts }))._unsafeUnwrap().text;
      assert.equal(result, await production(role, input.timeZone, patches));
      assert.ok(
        result.includes(
          patches["namespace/orb-instructions"] ??
            all.find((e) => e.id === "namespace/orb-instructions")?.content ??
            "MISSING",
        ),
      );
    }
  }
});

test("only consumed timezone and child atoms are required", async () => {
  const snapshot = (await source.snapshot(CATALOG, []))._unsafeUnwrap();
  const without = (...ids: string[]) => ({
    ...snapshot,
    entries: snapshot.entries.filter((e) => !ids.includes(e.id)),
  });
  const config = { harness: "pi", role: "root", timeZone: null } as const;
  const baseline = (await renderInitialSystem(snapshot, config))._unsafeUnwrap();
  assert.equal(
    (
      await renderInitialSystem(without("system/timezone", "system/child-restriction"), config)
    )._unsafeUnwrap(),
    baseline,
  );
  for (const [id, consumed] of [
    ["system/timezone", { ...config, timeZone: "America/Los_Angeles" }],
    ["system/child-restriction", { ...config, role: "subagent" }],
    ["namespace/orb-instructions", config],
  ] as const) {
    const result = await renderInitialSystem(without(id), consumed);
    assert.ok(result.isErr());
    assert.equal(result.error.code, "not_found");
    assert.ok(result.error.message.includes(id));
  }
});

test("annotated model API description equals real Harness offered definition, including prose drafts", async () => {
  const all = await entries();
  const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
  const pure = app.slice(
    app.indexOf("export function promptDelivery"),
    app.indexOf("const token ="),
  );
  const { composeInitialContext } = await import(
    `data:text/javascript;base64,${Buffer.from(pure).toString("base64")}`
  );
  for (const patches of [
    {},
    {
      "codemode/policy": "\nPOLICY_DRAFT 🦊 <xml> {{literal}}",
      "codemode/inline-images": "INLINE_DRAFT",
    },
    { "codemode/policy": "", "codemode/inline-images": "" },
  ] as Readonly<Record<string, string>>[]) {
    const staged = all.map((e) => ({ ...e, content: patches[e.id] ?? e.content }));
    for (const role of ["root", "subagent"] as const)
      for (const timeZone of [null, "America/Los_Angeles"]) {
        const capture: { description?: string } = {};
        const system = await production(role, timeZone, patches, capture);
        const recipe = composeInitialContext(staged, { harness: "pi", role });
        const description = recipe
          .find((s: { title: string }) => s.title === "functions.codemode · description")
          .parts.map((p: { text: string }) => p.text)
          .join("");
        assert.ok(capture.description !== undefined);
        assert.equal(typeof description, "string");
        assert.equal(description, capture.description);
        assert.doesNotMatch(description, /also saves the image/);
        assert.doesNotMatch(system, /POLICY_DRAFT|INLINE_DRAFT/);
      }
  }
});
