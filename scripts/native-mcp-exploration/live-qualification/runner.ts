import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { McpCatalog } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { createOrbMcpExtension } from "../../../apps/orb-runtime/src/mcp/native.ts";
import { HttpMcpTokenEndpoint } from "../../../apps/orb-runtime/src/mcp/oauth.ts";
import { installOneRejectedReadPost } from "./fault.mjs";
import {
  exactReviewedCall,
  redactResponseExcerpt,
  summarizeApplicationRead,
  summarizeCall,
  summarizeCloudflareRead,
  summarizeDatadogRead,
  summarizeGrant,
  summarizeReadShape,
} from "./policy.mjs";

const EXACT_REVIEWED_CALLS: Record<
  string,
  Record<string, Record<string, unknown> | Record<string, unknown>[]>
> = {
  cloudflare: {
    execute: {
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
    },
  },
  datadog: {
    search_datadog_monitors: [
      { max_tokens: 100, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
      { max_tokens: 1000, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
      {
        max_tokens: 1000,
        query: "status:alert",
        telemetry: { intent: "Qualify native MCP read-only monitor search" },
      },
      {
        max_tokens: 1000,
        query: "status:alert priority:p1",
        telemetry: { intent: "Qualify native MCP read-only monitor search" },
      },
    ],
  },
  posthog: { exec: { command: 'call dashboards-get-all {"limit":1}' } },
};
type Failure = {
  phase: "connection" | "guard" | "native_session";
  code: string;
};
const failure = (phase: Failure["phase"], code: string): Failure => ({ phase, code });
// SDK/platform calls are isolated here; exception details must never enter qualification evidence.
const platform = <T>(operation: () => Promise<T>, phase: Failure["phase"], code: string) =>
  ResultAsync.fromThrowable(operation, () => failure(phase, code))();

export async function runQualification(options: {
  catalog: McpCatalog;
  broker: { controlPlaneUrl: string; runtimeToken: string };
  secrets: Record<string, string>;
  phase: string;
  serverName?: string;
  toolName?: string;
  argument?: string;
  output: (record: Record<string, unknown>) => void;
  exactReviewed?: Record<
    string,
    Record<string, Record<string, unknown> | Record<string, unknown>[]>
  >;
}) {
  const { catalog, broker, secrets, phase, output } = options;
  const temporary = await platform(
    () => mkdtemp(join(tmpdir(), "native-mcp-qualification-")),
    "native_session",
    "tempdir_failed",
  );
  if (temporary.isErr()) return temporary;
  const dir = temporary.value;
  const events: {
    server: string;
    state: string;
    diagnostic?: { code: string; httpStatus?: number };
  }[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const target = catalog.servers.find((server) => server.name === options.serverName);
  const fault =
    phase === "reject-read" && target?.oauth ? installOneRejectedReadPost(target.url) : undefined;
  try {
    const resource = Result.fromThrowable(
      () =>
        new DefaultResourceLoader({
          cwd: dir,
          agentDir: dir,
          extensionFactories: [
            createOrbMcpExtension({
              configs: catalog.servers,
              secrets,
              broker,
              task: new NoSimulationTask("live-qualification", false),
              onState: ({ server, state, diagnostic }) =>
                events.push({ server, state, ...(diagnostic ? { diagnostic } : {}) }),
            }),
          ],
        }),
      () => failure("native_session", "loader_create_failed"),
    )();
    if (resource.isErr()) return resource;
    const loader = resource.value;
    const loaded = await platform(() => loader.reload(), "native_session", "loader_failed");
    if (loaded.isErr()) return loaded;
    const runtime = await platform(
      () =>
        ModelRuntime.create({
          authPath: join(dir, "auth.json"),
          allowModelNetwork: false,
        }),
      "native_session",
      "model_runtime_failed",
    );
    if (runtime.isErr()) return runtime;
    const modelRuntime = runtime.value;
    const created = await platform(
      () =>
        createAgentSession({
          cwd: dir,
          agentDir: dir,
          resourceLoader: loader,
          modelRuntime,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory(),
        }),
      "native_session",
      "session_create_failed",
    );
    if (created.isErr()) return created;
    const activeSession = created.value.session;
    session = activeSession;
    const bound = await platform(
      () => activeSession.bindExtensions({}),
      "native_session",
      "bind_failed",
    );
    if (bound.isErr()) return bound;
    const started = await platform(
      () =>
        activeSession.extensionRunner.emitBeforeAgentStart("qualification", undefined, {
          cwd: dir,
        }),
      "native_session",
      "startup_failed",
    );
    if (started.isErr()) return started;
    const registered = Result.fromThrowable(
      () => activeSession.extensionRunner.getAllRegisteredTools(),
      () => failure("native_session", "tools_list_failed"),
    )();
    if (registered.isErr()) return registered;
    const definitions = registered.value
      .map((item) => item.definition)
      .filter((d) => d.name.startsWith("mcp__"));
    for (const server of catalog.servers) {
      const tools = definitions
        .filter((d) => d.name.startsWith(`mcp__${server.name}__`))
        .map((d) => ({
          name: d.name.slice(`mcp__${server.name}__`.length),
          inputSchema: d.parameters,
          description: d.description,
        }));
      if (tools.length === 0) {
        const lastEvent = events.filter((event) => event.server === server.name).at(-1);
        output({
          phase: "connection_failure",
          server: server.name,
          state: lastEvent?.state ?? "unavailable",
          diagnostic: lastEvent?.diagnostic,
        });
        return err(failure("connection", "discovery_failed"));
      }
      output({
        phase: "discover",
        server: server.name,
        count: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          properties: Object.keys((t.inputSchema as { properties?: object })?.properties ?? {}),
          required: (t.inputSchema as { required?: string[] })?.required ?? [],
        })),
      });
      if (phase === "inspect" && server.name === options.serverName) {
        const selected = tools.find((tool) => tool.name === options.toolName);
        if (!selected) return err(failure("guard", "tool_unavailable"));
        output({
          phase: "inspect",
          server: server.name,
          tool: selected.name,
          description: selected.description?.slice(0, 6000),
          schema: JSON.stringify(selected.inputSchema).slice(0, 12000),
        });
      }
      if (
        !["call", "reject-read", "reconnect"].includes(phase) ||
        server.name !== options.serverName
      )
        continue;
      const toolName = options.toolName;
      const selected = tools.find((t) => t.name === toolName);
      if (!selected) return err(failure("guard", "tool_unavailable"));
      const parsed = Result.fromThrowable(
        () => JSON.parse(options.argument ?? "{}"),
        () => failure("guard", "invalid_argument"),
      )();
      if (parsed.isErr()) return parsed;
      const input = parsed.value;
      if (
        !exactReviewedCall(
          server.name,
          toolName,
          input,
          options.exactReviewed ?? EXACT_REVIEWED_CALLS,
        )
      )
        return err(failure("guard", "call_unapproved"));
      if (
        Object.keys(input).some(
          (key) =>
            !Object.hasOwn((selected.inputSchema as { properties?: object }).properties ?? {}, key),
        )
      )
        return err(failure("guard", "argument_unapproved"));
      const registeredTool = Result.fromThrowable(
        () => activeSession.extensionRunner.getToolDefinition(`mcp__${server.name}__${toolName}`),
        () => failure("native_session", "tool_lookup_failed"),
      )();
      if (registeredTool.isErr()) return registeredTool;
      const definition = registeredTool.value;
      if (!definition) return err(failure("guard", "native_tool_unavailable"));
      if (server.oauth) {
        const grant = await new HttpMcpTokenEndpoint(broker, server.oauth.id, server.url).request(
          new NoSimulationTask("live-qualification-grant", false),
          AbortSignal.timeout(20_000),
        );
        output(
          grant.isOk()
            ? { phase: "grant_before", ...summarizeGrant(server.name, grant.value) }
            : { phase: "grant_before", server: server.name, code: grant.error.code },
        );
        if (phase === "reject-read" && grant.isErr())
          return err(failure("guard", "grant_not_obtained"));
      }
      if (phase === "reconnect") {
        const command = activeSession.extensionRunner.getCommand("mcp");
        if (!command) return err(failure("guard", "native_reconnect_unavailable"));
        const beforeSessionId = activeSession.sessionManager.getSessionId();
        const levels: string[] = [];
        const context = Object.create(activeSession.extensionRunner.createCommandContext());
        Object.defineProperty(context, "ui", {
          value: { notify: (_message: string, level: string) => levels.push(level) },
        });
        const reconnect = await platform(
          () => command.handler(`reconnect ${server.name}`, context),
          "native_session",
          "native_reconnect_failed",
        );
        if (reconnect.isErr()) return reconnect;
        const sessionPreserved = activeSession.sessionManager.getSessionId() === beforeSessionId;
        output({
          phase: "reconnect",
          server: server.name,
          sessionPreserved,
          notificationLevels: levels,
        });
        if (!sessionPreserved || levels.includes("error"))
          return err(failure("connection", "native_reconnect_failed"));
      }
      const nativeSessionId = activeSession.sessionManager.getSessionId();
      const started = performance.now();
      const execute = () =>
        platform(
          () =>
            definition.execute(
              "qualification",
              input,
              AbortSignal.timeout(20_000),
              undefined,
              undefined as never,
            ),
          "native_session",
          "tool_execute_failed",
        );
      if (phase === "reject-read") fault?.arm();
      const execution = await execute();
      if (phase === "reject-read") {
        const evidence = fault?.evidence();
        output({
          phase: "fault",
          server: server.name,
          nativeSessionId,
          sessionPreserved: activeSession.sessionManager.getSessionId() === nativeSessionId,
          ...evidence,
        });
        if (evidence?.injected !== 1 || evidence.upstreamStatuses[0] !== 401)
          return err(failure("guard", "provider_401_not_observed"));
      }
      if (execution.isErr()) return execution;
      const result = execution.value;
      if (server.oauth) {
        const grant = await new HttpMcpTokenEndpoint(broker, server.oauth.id, server.url).request(
          new NoSimulationTask("live-qualification-grant", false),
          AbortSignal.timeout(20_000),
        );
        output(
          grant.isOk()
            ? { phase: "grant_after", ...summarizeGrant(server.name, grant.value) }
            : { phase: "grant_after", server: server.name, code: grant.error.code },
        );
      }
      output({
        phase: "call",
        ...summarizeCall(server.name, toolName, result, Math.round(performance.now() - started)),
        ...(server.name === "cloudflare" ? summarizeCloudflareRead(result) : {}),
        ...(server.name === "posthog" || server.name === "datadog"
          ? {
              application:
                server.name === "datadog"
                  ? summarizeDatadogRead(result)
                  : summarizeApplicationRead(result),
              shape: summarizeReadShape(result),
              excerpt: redactResponseExcerpt(result),
            }
          : {}),
      });
    }
    output({ phase: "states", events });
    return ok(undefined);
  } finally {
    fault?.restore();
    if (session) {
      const closing = session;
      await platform(
        () => closing.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        "native_session",
        "shutdown_failed",
      );
      Result.fromThrowable(
        () => closing.dispose(),
        () => failure("native_session", "dispose_failed"),
      )();
    }
    await platform(
      () => rm(dir, { recursive: true, force: true }),
      "native_session",
      "cleanup_failed",
    );
  }
}
