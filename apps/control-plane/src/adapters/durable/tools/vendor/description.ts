// Adapted from Pi 1.0.0; see PROVENANCE.md and LICENSE.
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import {
  MCP_TYPESCRIPT_PREAMBLE,
  mcpStructuredContentSchema,
  renderToolSample,
  toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
import type { PolicyTool, ToolNamespace } from "./types.ts";

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };
const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** One line per global. The details live in {@link CODEMODE_DOCS_PATH}. */
function describeGlobals(models: boolean): string {
  const lines = [
    "Globals:",
    "- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script.",
    "- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
    "- `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)`: find unlisted tools, such as MCP tools.",
  ];
  if (models) {
    lines.push(`- \`models\`: classifiers and image generation. Read the tool description first.`);
  }
  return lines.join("\n");
}

/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

/** What a script sees of a tool. Tools without an output schema resolve to their text output. */
export function toCodemodeDeclaration(tool: PolicyTool): Omit<CodemodeTool, "execute"> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
  };
}

/** Tools a script may call: every given tool except the codemode tool itself. */
export function getCodemodeCallableTools(tools: readonly PolicyTool[]): PolicyTool[] {
  return tools.filter((tool) => tool.name !== "codemode");
}

export interface CodemodeDescriptionOptions {
  /** Declare the `models` namespace; only for tools created with model access. */
  models?: boolean;
  /** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
  namespaces?: ReadonlyMap<string, ToolNamespace>;
  /** Tools that are callable but never listed with their declaration (`deferred` exposure). */
  deferred?: ReadonlySet<string>;
  /**
   * Estimated tokens (characters / 4) the tool sections may use. Tools that do not fit are left
   * out, like deferred tools. Unset lists every tool that is not deferred.
   */
  inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
  const id = toCodemodeIdentifier(declaration.name);
  const heading =
    id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
  return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
  name: string;
  section: string;
  cost: number;
}

interface CatalogGroup {
  namespace: ToolNamespace | undefined;
  entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog: in each round every group
 * (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a
 * group whose next tool does not fit drops out while the others continue. Every namespace is
 * represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
  if (budget === undefined)
    return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
  const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
  const shown = new Set<string>();
  let remaining = budget;
  let active = queues.filter((queue) => queue.length > 0);
  while (active.length > 0) {
    active = active.filter((queue) => {
      const next = queue[0]!;
      if (next.cost > remaining) return false;
      remaining -= next.cost;
      shown.add(next.name);
      queue.shift();
      return queue.length > 0;
    });
  }
  return shown;
}

/**
 * Model-facing description: the helper list, guidance for finding tools that are not listed, the
 * shared MCP types when listed tools need them, the `models` API, and one section per listed tool,
 * grouped by namespace. Deferred tools are never listed and do not affect the description at all, so
 * it stays the same while MCP servers connect or change their tools. Tool sections are limited to
 * `inlineBudget`.
 */
export function createCodemodeDescription(
  tools: readonly PolicyTool[],
  options: CodemodeDescriptionOptions = {},
): string {
  const declarations = tools
    .filter((tool) => tool.name !== "codemode")
    .filter((tool) => !options.deferred?.has(tool.name))
    .map(toCodemodeDeclaration);
  const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
  for (const declaration of declarations) {
    const namespace = options.namespaces?.get(declaration.name);
    const key = namespace ? `ns:${namespace.name}` : "";
    const group = groups.get(key) ?? { namespace, entries: [] };
    groups.set(key, group);
    const section = renderToolSection(declaration);
    group.entries.push({
      name: declaration.name,
      section,
      cost: Math.ceil(section.length / CHARS_PER_TOKEN),
    });
  }
  const ordered = [...groups.values()].sort((a, b) =>
    a.namespace === undefined
      ? -1
      : b.namespace === undefined
        ? 1
        : a.namespace.name.localeCompare(b.namespace.name),
  );
  const shown = selectCatalog(ordered, options.inlineBudget);

  const sections = [DESCRIPTION_INTRO, describeGlobals(false)];
  if (
    declarations.some(
      (declaration) =>
        shown.has(declaration.name) &&
        mcpStructuredContentSchema(declaration.outputSchema) !== undefined,
    )
  ) {
    sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
  }
  if (declarations.length === 0) return sections.join("\n\n");

  const toolSections = ["Nested tools:"];
  for (const { namespace, entries } of ordered) {
    const visible = entries.filter((entry) => shown.has(entry.name));
    if (namespace) {
      // Only tools that did not fit the budget are counted as not listed here.
      const listing =
        visible.length === entries.length
          ? ""
          : visible.length === 0
            ? " (tools not listed)"
            : " (some tools not listed)";
      const description = namespace.description?.trim();
      toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
    }
    for (const entry of visible) toolSections.push(entry.section);
  }
  sections.push(toolSections.join("\n\n"));
  return sections.join("\n\n");
}
