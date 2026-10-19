import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { renderPrompt } from "../../apps/control-plane/src/adapters/durable/prompt.ts";
import { createDurableTools } from "../../apps/control-plane/src/adapters/durable/tools/index.ts";
import { createOrbTools } from "../../apps/control-plane/src/adapters/durable/tools/orb-tools.ts";
import { snapshotPromptResources } from "../../apps/control-plane/src/adapters/git-resources/prompt.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "../../node_modules/@earendil-works/pi-durable/dist/truncate.js";
import {
  type Draft,
  type Entry,
  MAX_CONTENT_BYTES,
  type PromptError,
  type RenderConfig,
  type RenderSnapshot,
} from "./types.ts";

const invalid = (message: string): PromptError => ({ code: "invalid_request", message });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function parseRenderInput(
  input: unknown,
): Result<RenderConfig & { drafts: Draft[] }, PromptError> {
  if (
    !record(input) ||
    !keys(input, ["harness", "role", "timeZone", "drafts"]) ||
    (input.harness !== "pi" && input.harness !== "claude") ||
    (input.role !== "root" && input.role !== "subagent") ||
    (input.timeZone !== null && typeof input.timeZone !== "string") ||
    !Array.isArray(input.drafts)
  )
    return err(invalid("Expected harness, role, timeZone and drafts."));
  const timeZone = input.timeZone;
  if (timeZone !== null) {
    if (!timeZone || timeZone.length > 128) return err(invalid("Invalid time zone."));
    const valid = Result.fromThrowable(
      () => new Intl.DateTimeFormat("en-US", { timeZone }),
      () => invalid("Invalid time zone."),
    )();
    if (valid.isErr()) return err(valid.error);
  }
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const draft of input.drafts) {
    if (
      !record(draft) ||
      !keys(draft, ["id", "content", "revision"]) ||
      typeof draft.id !== "string" ||
      typeof draft.content !== "string" ||
      typeof draft.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(draft.revision) ||
      seen.has(draft.id)
    )
      return err(invalid("Expected unique prompt IDs, content and SHA-256 revisions."));
    const size = Buffer.byteLength(draft.content, "utf8");
    total += size;
    if (size > MAX_CONTENT_BYTES || total > MAX_CONTENT_BYTES * 6)
      return err({ code: "too_large", message: "Draft content exceeds the render limit." });
    seen.add(draft.id);
    drafts.push({ id: draft.id, content: draft.content, revision: draft.revision });
  }
  if (input.harness === "claude")
    return err({
      code: "unsupported",
      message: "Claude’s complete native system preset is not available in this checkout.",
    });
  return ok({ harness: input.harness, role: input.role, timeZone: input.timeZone, drafts });
}

/** Construction only. No callable, sandbox, workload, discovery or provider is invoked. */
function nativeTools(role: RenderConfig["role"]) {
  const bundle = createDurableTools({
    additionalTools: createOrbTools({
      invoke: () =>
        errAsync({ code: "unavailable", message: "Prompt rendering cannot execute tools." }),
    }),
  });
  const extension = role === "root" ? bundle.extension : bundle.childExtension;
  return {
    tools: (extension.tools ?? []).filter(
      (tool) => tool.name !== "codemode" && tool.deferred !== true,
    ),
    catalog: bundle.catalog,
    section: extension.sections?.[0],
  };
}

/** Replace parameter descriptions recursively, preserving the factory's complete schema. */
function parameters(schema: unknown, tool: string, entries: ReadonlyMap<string, Entry>): unknown {
  if (Array.isArray(schema)) return schema.map((value) => parameters(value, tool, entries));
  if (!record(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (key !== "properties" || !record(value)) return [key, parameters(value, tool, entries)];
      return [
        key,
        Object.fromEntries(
          Object.entries(value).map(([name, property]) => {
            const nested = parameters(property, tool, entries);
            const entry = entries.get(`parameter/${tool}/${name}`);
            return [
              name,
              entry && record(nested) ? { ...nested, description: entry.content } : nested,
            ];
          }),
        ),
      ];
    }),
  );
}

function text(
  entry: Entry,
  values: Readonly<Record<string, string>> = {},
): Result<string, PromptError> {
  let rendered = entry.content;
  for (const variable of entry.variables ?? []) {
    const value = values[variable];
    if (value === undefined)
      return err({ code: "unsupported", message: `No local value for ${entry.id}: ${variable}.` });
    rendered = rendered.replace(`{{${variable}}}`, () => value);
  }
  return ok(rendered);
}

/** Native catalogue formatting and skill parsing; only prose is supplied by the staged AST snapshot. */
export function renderInitialSystem(
  snapshot: RenderSnapshot,
  config: RenderConfig,
): ResultAsync<string, PromptError> {
  return ResultAsync.fromSafePromise(renderInitialResult(snapshot, config)).andThen(
    (result) => result,
  );
}

async function renderInitialResult(
  snapshot: RenderSnapshot,
  config: RenderConfig,
): Promise<Result<string, PromptError>> {
  if (config.harness !== "pi")
    return err({
      code: "unsupported",
      message: "Claude’s complete native system preset is not available in this checkout.",
    });
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const required = [
    "system/preamble",
    "system/environment",
    "system/environment-pi",
    "system/codemode",
    ...(config.timeZone ? ["system/timezone"] : []),
    ...(config.role === "subagent" ? ["system/child-restriction"] : []),
    "repository/instructions",
    "namespace/orb-description",
    "namespace/orb-instructions",
  ];
  for (const id of required)
    if (!entries.has(id))
      return err({ code: "not_found", message: `Required prompt is missing: ${id}.` });
  const get = (id: string, values?: Readonly<Record<string, string>>) => {
    const entry = entries.get(id);
    return entry
      ? text(entry, values)
      : err<string, PromptError>({
          code: "not_found",
          message: `Required prompt is missing: ${id}.`,
        });
  };
  const skills = snapshotPromptResources({
    orbId: "local-render",
    commitSha: "checkout",
    instructionPath: null,
    skillRoot: "/opt/pi-orb/skills",
    files: snapshot.resources.map(({ path, content }) => ({
      path,
      bytes: Buffer.from(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  }).mapErr((error): PromptError => ({ code: "invalid_request", message: error.message }));
  if (skills.isErr()) return err(skills.error);
  const constructed = Result.fromThrowable(
    () => nativeTools(config.role),
    (): PromptError => ({
      code: "unsupported",
      message: "Native tool definitions could not be constructed.",
    }),
  )();
  if (constructed.isErr()) return err(constructed.error);
  const native = constructed.value;
  const tools: ToolRegistration[] = [];
  for (const tool of native.tools) {
    const id = tool.name === "mcp_status" ? "tool/mcp-status" : `tool/${tool.name}`;
    const description = entries.get(id) ?? entries.get(`upstream/durable/${tool.name}-description`);
    const resolved = description
      ? text(description, {
          line_limit: String(DEFAULT_MAX_LINES),
          kilobyte_limit: String(DEFAULT_MAX_BYTES / 1024),
        })
      : ok(tool.description);
    if (resolved.isErr()) return err(resolved.error);
    tools.push({
      ...tool,
      description: resolved.value,
      parameters: parameters(tool.parameters, tool.name, entries) as ToolRegistration["parameters"],
    });
  }
  const namespace = get("namespace/orb-description");
  const policy = get("namespace/orb-instructions");
  if (namespace.isErr()) return err(namespace.error);
  if (policy.isErr()) return err(policy.error);
  const original = native.catalog.namespaceValues().find((ns) => ns.name === "orb");
  if (!original || !native.section)
    return err({ code: "unsupported", message: "Native code-mode section is unavailable." });
  native.catalog.namespace({
    ...original,
    description: namespace.value,
    instructions: policy.value,
  });
  const section = native.section;
  const catalogue = await ResultAsync.fromThrowable(
    async () =>
      section.render(
        {
          conversationId: ROOT_CONVERSATION_ID,
          agent: {
            thinkingLevel: "off",
            extensions: [],
            tools: [],
            callable: tools,
            deferred: [],
            sections: [],
          },
          env: undefined,
          shown: {},
          read: { snapshot: async () => undefined, snapshotAsOf: async () => undefined },
        },
        BACKGROUND_CONTEXT,
      ),
    (): PromptError => ({
      code: "unsupported",
      message: "Native tool catalogue could not be rendered.",
    }),
  )();
  if (catalogue.isErr()) return err(catalogue.error);
  if (!catalogue.value)
    return err({ code: "unsupported", message: "Native tool catalogue is unavailable." });
  const catalogueText =
    section.tag === false
      ? catalogue.value
      : `<${section.key}>\n${catalogue.value}\n</${section.key}>`;
  const parts = Result.combine([
    get("system/preamble"),
    get("repository/instructions"),
    Result.combine([
      get("system/codemode"),
      ...(config.timeZone ? [get("system/timezone", { time_zone: config.timeZone })] : []),
    ]).map((parts) => parts.join("\n\n")),
    get("system/environment"),
    get("system/environment-pi"),
  ]);
  if (parts.isErr()) return err(parts.error);
  const [preamble, repository, appendSystem, environment, piEnvironment] = parts.value;
  if (
    preamble === undefined ||
    repository === undefined ||
    appendSystem === undefined ||
    environment === undefined ||
    piEnvironment === undefined
  )
    return err({ code: "unsupported", message: "Required instruction data is unavailable." });
  const rendered = Result.fromThrowable(
    () =>
      renderPrompt(
        {
          personal: "",
          project: "",
          repository: [{ path: "AGENTS.md", content: repository }],
          appendSystem,
          skills: skills.value.skills,
        },
        { preamble, environment, piEnvironment },
      ),
    (): PromptError => ({
      code: "unsupported",
      message: "Native instructions could not be rendered.",
    }),
  )();
  if (rendered.isErr()) return err(rendered.error);
  let instructions = rendered.value;
  if (config.role === "subagent") {
    const child = get("system/child-restriction", { parent_instructions: instructions });
    if (child.isErr()) return err(child.error);
    instructions = child.value;
  }
  return ok(`${catalogueText}\n\n<orb-instructions>\n${instructions}\n</orb-instructions>`);
}
