// Adapted from Pi 1.0.0; see PROVENANCE.md and LICENSE.
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "./search.ts";
import type { PolicyTool, ToolNamespace } from "./types.ts";

/**
 * Whether `query` names the namespace: its name, its script identifier (`mcp__dev-radius` is
 * `mcp__dev_radius`), or the part after its last `__` in either form (`dev-radius`, `dev_radius`).
 */
function isNamespaceName(namespace: string, query: string): boolean {
  const id = toCodemodeIdentifier(namespace);
  const queryId = toCodemodeIdentifier(query);
  const suffix = (name: string) =>
    name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined;
  return (
    namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId
  );
}

/**
 * `searchTools()`, `describeTool()`, and `describeNamespace()`: ranked search and lookup over the
 * script's nested tools and their namespaces.
 */
export function createDiscoveryGlobals(
  tools: readonly PolicyTool[],
  samples: ReadonlyMap<string, string>,
  options: {
    getToolNamespace?: (name: string) => ToolNamespace | undefined;
    namespaces?: readonly ToolNamespace[];
    getNamespaces?: () => readonly ToolNamespace[];
  },
): CodemodeTool[] {
  const ranker = new Bm25Ranker();
  const entry = (name: string) => ({
    name: toCodemodeIdentifier(name),
    description: samples.get(name) ?? "",
  });
  return [
    {
      name: "searchTools",
      spread: true,
      execute: (args) => {
        const [query, searchOptions] = args as [
          unknown,
          { limit?: unknown; namespace?: unknown } | undefined,
        ];
        if (typeof query !== "string")
          // biome-ignore lint/plugin/no-throw: QuickJS callback contract
          throw new Error("searchTools() expects a query string");
        const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
          // biome-ignore lint/plugin/no-throw: QuickJS callback contract
          throw new Error("searchTools() limit must be a positive integer");
        }
        const namespace = searchOptions?.namespace;
        if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
          // biome-ignore lint/plugin/no-throw: QuickJS callback contract
          throw new Error("searchTools() namespace must be a string");
        }
        const documents = tools.flatMap((tool) => {
          const toolNamespace = options.getToolNamespace?.(tool.name);
          if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace)))
            return [];
          return [createToolSearchDocument(tool, toolNamespace)];
        });
        return ranker.rank(query, documents, limit).map((match) => entry(match.name));
      },
    },
    {
      name: "describeTool",
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== "string")
          // biome-ignore lint/plugin/no-throw: QuickJS callback contract
          throw new Error("describeTool() expects a tool name");
        const tool = tools.find(
          (candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
        );
        return tool ? samples.get(tool.name) : undefined;
      },
    },
    {
      name: "describeNamespace",
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== "string")
          // biome-ignore lint/plugin/no-throw: QuickJS callback contract
          throw new Error("describeNamespace() expects a namespace name");
        let namespace: ToolNamespace | undefined;
        const names: string[] = [];
        for (const tool of tools) {
          const toolNamespace = options.getToolNamespace?.(tool.name);
          if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
          namespace ??= toolNamespace;
          names.push(toCodemodeIdentifier(tool.name));
        }
        namespace ??= (options.getNamespaces?.() ?? options.namespaces)?.find((ns) =>
          isNamespaceName(ns.name, name),
        );
        if (!namespace) return undefined;
        return {
          name: namespace.name,
          ...(namespace.description ? { description: namespace.description } : {}),
          ...(namespace.instructions ? { instructions: namespace.instructions } : {}),
          tools: names,
        };
      },
    },
  ];
}
