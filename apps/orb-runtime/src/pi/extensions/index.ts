import {
  type AgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { err, Result } from "neverthrow";
import { createSubagentsExtension, type SubagentHost } from "./subagents.ts";

export function activateCodemode(
  session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">,
): Result<void, string> {
  const activated = Result.fromThrowable(
    () => session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]),
    () => "Pi codemode could not activate",
  )();
  if (activated.isErr()) return err(activated.error);
  return session.getActiveToolNames().includes("codemode")
    ? activated
    : err("Pi codemode could not activate");
}

export type NativeMcpExtensionDeps = ExtensionFactory;

/** Each factory binds to its own Pi session; child connections never share root ownership. */
function nativeExtensions(mcp?: NativeMcpExtensionDeps): InlineExtension[] {
  return [
    {
      name: "pi-orb:mcp",
      factory: mcp ?? createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
    },
    { name: "pi-orb:tool-search", factory: createToolSearchExtension() },
    { name: "pi-orb:codemode", factory: createCodemodeExtension({ mode: "on" }) },
  ];
}

/** Explicit first-party composition; user/project discovery remains Pi-owned. */
export function createOrbExtensions(deps: {
  cwd: string;
  mcp?: NativeMcpExtensionDeps;
  subagents?: SubagentHost;
}): InlineExtension[] {
  return [
    ...(deps.subagents
      ? [
          {
            name: "pi-orb:subagents",
            factory: createSubagentsExtension(deps.subagents, deps.cwd, nativeExtensions(deps.mcp)),
          },
        ]
      : []),
    ...nativeExtensions(deps.mcp),
  ];
}
