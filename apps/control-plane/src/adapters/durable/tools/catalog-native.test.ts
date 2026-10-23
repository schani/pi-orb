import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Tool, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { CODEMODE_BOOTSTRAP } from "./codemode.ts";
import { PiCodemodeSandbox } from "./codemode-sandbox.ts";
import { createDurableTools } from "./index.ts";
import { createOrbTools } from "./orb-tools.ts";
import { ChildAnchor, subagentTools } from "./subagents.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

async function nativeMetadata(
  bundle: ReturnType<typeof createDurableTools>,
  scope: "root" | "child",
  source: string,
) {
  let result: ToolExecutionResult | undefined;
  let metadata = "";
  let offered: Tool[] = [];
  const registry = createRegistry();
  const nativeSection = createCodemodeExtension({
    sandbox: new PiCodemodeSandbox(),
    models: false,
    namespaces: bundle.catalog.nativeNamespaces(),
  }).sections?.[0];
  if (!nativeSection) return expect.fail("Native catalogue section missing");
  for (const extension of [bundle.extension, bundle.childExtension])
    registry.install(
      defineExtension({
        ...extension,
        sections: (extension.sections ?? []).map((section) => ({
          ...section,
          render: async (input, ctx) => {
            const rendered = await section.render(input, ctx);
            const native = await nativeSection.render(input, ctx);
            const intro = "Tools scripts can call (`await tools.<name>(args)`):\n\n";
            expect(native?.startsWith(intro)).toBe(true);
            expect(rendered).toBe(native?.slice(intro.length));
            return rendered;
          },
        })),
        tools: extension.tools!.map((tool) =>
          tool.name !== "codemode"
            ? tool
            : defineTool({
                ...tool,
                execute: async (args, api, ctx) => {
                  result = await tool.execute(args, api, ctx);
                  return result;
                },
              }),
        ),
      }),
    );
  const faux = fauxProvider();
  faux.setResponses([
    async (request) => {
      offered = request.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      );
      metadata = JSON.stringify(request.messages.filter((message) => message.role === "system"));
      return fauxAssistantMessage(fauxToolCall("codemode", { code: source }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        modelTools: bundle.modelTools,
        extensions: { remove: [bundle.childExtension] },
      },
    });
    if (scope === "child") {
      const anchor = await root.commit(
        (tx) =>
          tx.createTask(
            ChildAnchor,
            {
              prompt: "run",
              description: "native declarations",
            },
            { ownership: { kind: "conversation" }, background: true },
          ),
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      await harness.waitForTask(anchor, BACKGROUND_CONTEXT);
    } else {
      harness.resume();
      await (await root.submit({ type: "input", content: "run" }, BACKGROUND_CONTEXT)).wait(
        BACKGROUND_CONTEXT,
      );
    }
    expect(offered.map((tool) => tool.name)).toEqual(["codemode"]);
    expect(offered[0]?.description).toBe(CODEMODE_BOOTSTRAP);
    expect(JSON.stringify(offered[0])).not.toMatch(/Run JavaScript|Globals:|8-outstanding/);
    expect(metadata).toContain("<tool-catalogue>");
    expect(metadata).not.toContain("<codemode>");
    expect(metadata).not.toContain("Tools scripts can call");
    for (const guidance of [
      "Namespace orb: discover with describeNamespace(",
      "Namespace mcp: discover with describeNamespace(",
      "Use archive/delete only on explicit user request",
      "Stop/sleep revokes execution admission",
      "a connected browser does not override Stop",
      "Use server names from MCP namespaces",
      "list resources/templates before reading unfamiliar URIs",
      "Fixture server instructions before first use",
    ])
      expect(metadata).not.toContain(guidance);
    for (const extension of [bundle.extension, bundle.childExtension]) {
      expect(extension.sections?.map((section) => section.key)).toContain("tool-catalogue");
      expect(extension.sections?.map((section) => section.key)).not.toContain("codemode");
    }
    expect(CODEMODE_BOOTSTRAP).not.toContain("Tools scripts can call");
    expect(result).toBeDefined();
    return { metadata, result: result! };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

describe("native callable registrations", () => {
  it("prepares once before the native validation boundary and authorizes the prepared value", async () => {
    let preparations = 0;
    const authorized: unknown[] = [];
    const catalog = new CallableCatalog(
      [
        defineTool({
          name: "prepared",
          description: "prepared",
          parameters: Type.Object({ value: Type.String() }),
          prepareArguments: (args) => {
            preparations++;
            if (typeof args !== "string") return expect.fail("Expected raw string arguments");
            return { value: args };
          },
          execute: async (args) => ({ output: [{ type: "text", text: args.value }] }),
        }),
      ],
      (_name, args) => {
        authorized.push(args);
        return okAsync(undefined);
      },
    );
    const fixture = await openCodemodeHarness(catalog);
    try {
      const result = await fixture.run('return await tools.prepared("safe");');
      expect(result.isError).toBe(false);
      expect(result.output).toContainEqual({ type: "text", text: "safe" });
      expect(preparations).toBe(1);
      expect(authorized).toEqual([{ value: "safe" }]);
      const tool = catalog.registrations()[0]!;
      expect(tool.callers).toEqual(["tools"]);
      expect(tool.structuredOutputSchema).toBeDefined();
    } finally {
      await fixture.close();
    }
  });

  it("preserves image output for programs rather than native text-only collapse", async () => {
    const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
    const catalog = new CallableCatalog([
      defineTool({
        name: "image_tool",
        description: "image",
        parameters: Type.Object({}),
        execute: async () => ({ output: [image] }),
      }),
    ]);
    const result = await catalog
      .registrations()[0]!
      .execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(result.structuredOutput).toEqual([image]);
  });
});

it.each(["root", "child"] as const)(
  "declares real native object, string and image-array contracts in %s discovery and inline metadata",
  async (scope) => {
    const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
    const orbTools = createOrbTools({
      invoke: () =>
        okAsync({
          orb: { id: "orb-id", name: null, url: "url", createdAt: "now" },
          project: { id: "project", name: "Project", repositoryUrl: null },
          spawnedByOrb: null,
          children: [],
          previewHost: null,
        }),
    });
    const bundle = createDurableTools({
      additionalTools: [
        ...orbTools,
        defineTool({
          name: "image_callback",
          description: "Image callback",
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: "text", text: "caption" }, image] }),
        }),
      ],
      files: { read: () => okAsync({ output: [image] }) },
    });
    try {
      const extension = scope === "root" ? bundle.extension : bundle.childExtension;
      const names = [
        ...orbTools
          .map((tool) => tool.name)
          .filter((name) =>
            scope === "root"
              ? name !== "notify_parent"
              : !["orb_spawn", "orb_alert"].includes(name),
          ),
        ...(scope === "root" ? subagentTools.map((tool) => tool.name) : []),
      ];
      const { metadata, result } = await nativeMetadata(
        bundle,
        scope,
        `
      const strings = {};
      for (const name of ${JSON.stringify(names)}) strings[name] = (await describeTool(name)).includes("Promise<string>");
      text({strings, read:await describeTool("read"), callback:await describeTool("image_callback"),
        orbDeclaration:await describeTool("orb_self"), identity:await tools.orb_self({}), image:await tools.read({path:"image.png"}),
        mixed:await tools.image_callback({}), childCanSpawn:ALL_TOOLS.some((tool) => tool.name === "orb_spawn"),
        childCanSubagent:ALL_TOOLS.some((tool) => tool.name === "subagent")});
    `,
      );
      expect(result.isError).toBe(false);
      const text = result.output?.[1];
      if (text?.type !== "text") return expect.fail("Native script payload missing");
      const payload = JSON.parse(text.text);
      expect(payload.strings).toEqual(
        Object.fromEntries(
          names.map((name) => [name, !name.startsWith("orb_") && name !== "notify_parent"]),
        ),
      );
      expect(payload.identity.orb.id).toBe("orb-id");
      expect(payload.image).toEqual([image]);
      expect(payload.mixed).toEqual([{ type: "text", text: "caption" }, image]);
      expect(payload.read).toContain("Promise<string | Array<");
      expect(payload.read).toContain('type: "image"');
      expect(payload.callback).toContain("Promise<string | Array<");
      expect(payload.callback).toContain('type: "image"');
      expect(payload.callback).toContain('type: "text"');
      expect(payload.childCanSpawn).toBe(scope === "root");
      expect(payload.childCanSubagent).toBe(scope === "root");
      expect(metadata).toContain("## orb");
      expect(metadata).toContain("Orb lifecycle and conversation operations");
      expect(metadata).toContain("Get this orb's identity, project, parent provenance");
      expect(metadata).toContain("orb_self(args: {}): Promise<{");
      expect(payload.orbDeclaration).toContain("orb: {");
      expect(payload.orbDeclaration).toContain("error: {");
      expect(payload.orbDeclaration).toContain('"unauthorized"');
      expect(metadata).toContain(
        "image_callback(args: { [key: string]: unknown; }): Promise<string | Array<",
      );
      if (scope === "root") expect(metadata).toContain("list_subagents(args: {}): Promise<string>");
      else expect(metadata).not.toContain("subagent(args:");
      expect(extension.tools?.find((tool) => tool.name === "codemode")?.callers).toEqual(["model"]);
      for (const name of names) {
        const schema = extension.tools?.find((tool) => tool.name === name)?.structuredOutputSchema;
        if (name.startsWith("orb_") || name === "notify_parent")
          expect(schema).toHaveProperty("anyOf");
        else expect(schema).toEqual({ type: "string" });
      }
    } finally {
      await bundle.close();
    }
  },
);

it.each(["root", "child"] as const)(
  "preserves the full MCP raw schema and result in %s native declarations",
  async (scope) => {
    const raw = {
      content: [{ type: "text", text: "raw text" }],
      structuredContent: [1, null, "value"],
      isError: false,
      _meta: { trace: "kept" },
    };
    const bundle = createDurableTools({
      mcp: [
        {
          name: "fixture",
          connect: () => {
            const { client, server } = createInMemoryTransportPair();
            server.onMessage((message) => {
              if (!("method" in message) || !("id" in message)) return;
              void server.send({
                jsonrpc: "2.0",
                id: message.id,
                result:
                  message.method === "initialize"
                    ? {
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: "fixture", version: "1" },
                        instructions: "Fixture server instructions before first use",
                      }
                    : message.method === "tools/list"
                      ? {
                          tools: [
                            {
                              name: "raw",
                              inputSchema: { type: "object" },
                              outputSchema: {
                                type: "array",
                                items: {
                                  anyOf: [{ type: "number" }, { type: "null" }, { type: "string" }],
                                },
                              },
                            },
                          ],
                        }
                      : raw,
              });
            });
            void server.start();
            return okAsync(client);
          },
        },
      ],
    });
    try {
      expect((await bundle.ready()).isOk()).toBe(true);
      const extension = scope === "root" ? bundle.extension : bundle.childExtension;
      const { metadata, result } = await nativeMetadata(
        bundle,
        scope,
        'text({namespace:await describeNamespace("mcp__fixture"),resources:await describeNamespace("mcp"),declaration:await describeTool("mcp__fixture__raw"),raw:await tools.mcp__fixture__raw({})});',
      );
      expect(result.isError).toBe(false);
      const text = result.output?.[1];
      if (text?.type !== "text") return expect.fail("Native script payload missing");
      const payload = JSON.parse(text.text);
      expect(payload.raw).toEqual(raw);
      expect(payload.namespace.instructions).toBe("Fixture server instructions before first use");
      expect(payload.resources.instructions).toBe(
        "Use server names from MCP namespaces; list resources/templates before reading unfamiliar URIs.",
      );
      for (const field of [
        "content:",
        "structuredContent?: Array<number | null | string>",
        "isError?: boolean",
        "_meta?:",
      ]) {
        expect(payload.declaration).toContain(field);
      }
      expect(metadata).not.toContain("mcp__fixture__raw(args:");
      expect(metadata).not.toContain("structuredContent?: Array<number | null | string>");
      const native = extension.tools?.find((tool) => tool.name === "mcp__fixture__raw");
      if (!native) return expect.fail("Native MCP raw fixture missing");
      expect(native.deferred).toBe(true);
      expect(JSON.parse(JSON.stringify(native.structuredOutputSchema))).toEqual({
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          isError: { type: "boolean" },
          _meta: { type: "object", patternProperties: { "^.*$": {} } },
          structuredContent: {
            type: "array",
            items: { anyOf: [{ type: "number" }, { type: "null" }, { type: "string" }] },
            "~optional": true,
          },
        },
        required: ["content"],
      });
    } finally {
      await bundle.close();
    }
  },
);

it.each(["root", "child"] as const)(
  "separates notification discovery, descriptions and native calls in %s",
  async (scope) => {
    const effects: string[] = [];
    const own = scope === "root" ? "orb_alert" : "notify_parent";
    const hidden = scope === "root" ? "notify_parent" : "orb_alert";
    const bundle = createDurableTools({
      additionalTools: [
        ...createOrbTools(
          {
            invoke: (request) => {
              effects.push(request.kind);
              return okAsync(
                request.kind === "alert"
                  ? { recordId: "record", duplicate: false }
                  : { accepted: true },
              );
            },
          },
          () => {
            effects.push("notify");
            return okAsync({ accepted: true });
          },
        ),
        defineTool({
          name: "probe_hidden",
          description: "Probe native notification scope",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            const result = await api.executeTool(hidden, { message: "forbidden" }, ctx);
            return { output: [{ type: "text", text: String(result.isError) }] };
          },
        }),
      ],
    });
    try {
      expect((await bundle.ready()).isOk()).toBe(true);
      const extension = scope === "root" ? bundle.extension : bundle.childExtension;
      expect(extension.tools?.map((tool) => tool.name)).toContain(own);
      expect(extension.tools?.map((tool) => tool.name)).not.toContain(hidden);
      if (scope === "root") {
        expect(bundle.catalog.definitions().map((tool) => tool.name)).not.toContain(hidden);
        expect(
          (
            await bundle.catalog.invoke(
              hidden,
              { message: "forbidden" },
              {} as ToolExecutionApi,
              BACKGROUND_CONTEXT,
            )
          ).isErr(),
        ).toBe(true);
      }
      const { metadata, result } = await nativeMetadata(
        bundle,
        scope,
        `
        let described = false, called = false;
        try { described = (await describeTool("${hidden}")) !== undefined; } catch {}
        try { await tools["${hidden}"]({message:"forbidden"}); called = true; } catch {}
        text({
          listed: ALL_TOOLS.some((tool) => tool.name === "${hidden}"),
          searched: await searchTools("${hidden}"),
          described, called,
          namespace: await describeNamespace("orb"),
          own: await describeTool("${own}"),
          accepted: await tools["${own}"]({message:"report"}),
          nativeDenied: await tools.probe_hidden({}),
        });
      `,
      );
      expect(result.isError).toBe(false);
      const payload = JSON.parse(
        result.output!.filter((item) => item.type === "text").at(-1)!.text,
      );
      expect(payload.listed).toBe(false);
      expect(payload.described).toBe(false);
      expect(payload.called).toBe(false);
      expect(JSON.stringify(payload.searched)).not.toContain(hidden);
      expect(JSON.stringify(payload.namespace)).not.toContain(hidden);
      expect(payload.namespace.instructions).toBe(
        "Use archive/delete only on explicit user request. Stop/sleep revokes execution admission; a connected browser does not override Stop.",
      );
      expect(payload.own).toContain(own);
      expect(payload.accepted).toEqual(
        scope === "root" ? { recordId: "record", duplicate: false } : { accepted: true },
      );
      expect(payload.nativeDenied).toBe("true");
      expect(metadata).not.toContain(hidden);
      expect(metadata).toContain(own);
      expect(effects).toEqual(scope === "root" ? ["alert"] : ["notification_admission", "notify"]);
    } finally {
      await bundle.close();
    }
  },
);

it("returns expected orb errors as objects through native codemode with visible diagnostics", async () => {
  const error = { code: "unauthorized" as const, message: "agent identity rejected" };
  const bundle = createDurableTools({
    additionalTools: createOrbTools({ invoke: () => errAsync(error) }),
  });
  try {
    const { result } = await nativeMetadata(
      bundle,
      "root",
      "const result = await tools.orb_self({}); text({code:result.error.code,message:result.error.message});",
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({ type: "text", text: JSON.stringify(error) });
  } finally {
    await bundle.close();
  }
});

it.each([false, true])(
  "preserves native alert duplicate=%s receipts through codemode",
  async (duplicate) => {
    const receipt = { recordId: "record", duplicate };
    const bundle = createDurableTools({
      additionalTools: createOrbTools({ invoke: () => okAsync(receipt) }),
    });
    try {
      const { result } = await nativeMetadata(
        bundle,
        "root",
        "const receipt = await tools.orb_alert({message:'notice'}); text({receipt,done:true});",
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContainEqual({
        type: "text",
        text: JSON.stringify({ receipt, done: true }),
      });
    } finally {
      await bundle.close();
    }
  },
);
