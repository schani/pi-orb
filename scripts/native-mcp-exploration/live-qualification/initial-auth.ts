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
import { err, ok, ResultAsync } from "neverthrow";
import { createOrbMcpExtension } from "../../../apps/orb-runtime/src/mcp/native.ts";
import { HttpMcpTokenEndpoint } from "../../../apps/orb-runtime/src/mcp/oauth.ts";
import { summarizeCall, summarizeCloudflareRead, summarizeDatadogRead } from "./policy.mjs";

const calls = {
  cloudflare: {
    tool: "execute",
    input: {
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
    },
  },
  datadog: {
    tool: "search_datadog_monitors",
    input: {
      max_tokens: 1000,
      query: "status:alert priority:p1",
      telemetry: { intent: "Qualify native MCP read-only monitor search" },
    },
  },
} as const;
type Failure = { phase: string; code: string };
const failure = (phase: string, code: string): Failure => ({ phase, code });
const safe = <T>(fn: () => Promise<T>, phase: string, code: string) =>
  ResultAsync.fromThrowable(fn, () => failure(phase, code))();

export async function runInitialAuth(options: {
  catalog: McpCatalog;
  broker: { controlPlaneUrl: string; runtimeToken: string };
  secrets: Record<string, string>;
  waitForResume: () => Promise<void>;
  output: (record: Record<string, unknown>) => void;
}) {
  const { catalog, broker, output } = options;
  if (
    catalog.servers.length !== 2 ||
    !["cloudflare", "datadog"].every((name) => catalog.servers.some((s) => s.name === name))
  )
    return err(failure("guard", "unexpected_catalog"));
  const dir = await safe(
    () => mkdtemp(join(tmpdir(), "native-mcp-initial-auth-")),
    "session",
    "tempdir_failed",
  );
  if (dir.isErr()) return dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const events: {
    server: string;
    state: string;
    diagnostic?: { code: string; httpStatus?: number };
  }[] = [];
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir.value,
      agentDir: dir.value,
      extensionFactories: [
        createOrbMcpExtension({
          configs: catalog.servers,
          secrets: options.secrets,
          broker,
          task: new NoSimulationTask("initial-auth-qualification", false),
          onState: ({ server, state, diagnostic }) =>
            events.push({ server, state, ...(diagnostic ? { diagnostic } : {}) }),
        }),
      ],
    });
    const loaded = await safe(() => loader.reload(), "session", "loader_failed");
    if (loaded.isErr()) return loaded;
    const runtime = await safe(
      () =>
        ModelRuntime.create({ authPath: join(dir.value, "auth.json"), allowModelNetwork: false }),
      "session",
      "runtime_failed",
    );
    if (runtime.isErr()) return runtime;
    const created = await safe(
      () =>
        createAgentSession({
          cwd: dir.value,
          agentDir: dir.value,
          resourceLoader: loader,
          modelRuntime: runtime.value,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory(),
        }),
      "session",
      "create_failed",
    );
    if (created.isErr()) return created;
    session = created.value.session;
    const active = session;
    const bound = await safe(() => active.bindExtensions({}), "session", "bind_failed");
    if (bound.isErr()) return bound;
    const sessionId = active.sessionManager.getSessionId();
    const prompt = async () =>
      safe(
        () =>
          active.extensionRunner.emitBeforeAgentStart(
            { messageType: "user", prompt: "qualification" },
            { cwd: dir.value },
          ),
        "session",
        "prompt_failed",
      );
    const first = await prompt();
    if (first.isErr()) return first;
    const names = () =>
      active.extensionRunner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name)
        .filter((name) => name.startsWith("mcp__"));
    for (const server of catalog.servers) {
      const event = events.filter((item) => item.server === server.name).at(-1);
      output({
        phase: "initial_auth",
        server: server.name,
        sessionId,
        state: event?.state,
        diagnostic: event?.diagnostic,
        toolCount: names().filter((name) => name.startsWith(`mcp__${server.name}__`)).length,
      });
      if (
        event?.state !== "needs-auth" ||
        event.diagnostic?.code !== "auth_required" ||
        names().some((name) => name.startsWith(`mcp__${server.name}__`))
      )
        return err(failure("initial_auth", "expected_auth_required_without_tools"));
    }
    output({
      phase: "await_human",
      sessionId,
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const resumed = await safe(options.waitForResume, "resume", "signal_expired_or_unavailable");
    if (resumed.isErr()) return resumed;
    if (active.sessionManager.getSessionId() !== sessionId)
      return err(failure("session", "session_changed"));
    const second = await prompt();
    if (second.isErr()) return second;
    for (const name of ["cloudflare", "datadog"] as const) {
      const definition = active.extensionRunner.getToolDefinition(
        `mcp__${name}__${calls[name].tool}`,
      );
      const count = names().filter((tool) => tool.startsWith(`mcp__${name}__`)).length;
      const last = events.filter((item) => item.server === name).at(-1);
      output({ phase: "rediscovery", server: name, sessionId, count, state: last?.state });
      if (!definition || !count || last?.state !== "connected")
        return err(failure("rediscovery", "tools_unavailable"));
      const server = catalog.servers.find((item) => item.name === name);
      if (!server?.oauth) return err(failure("guard", "oauth_binding_unavailable"));
      const grant = await new HttpMcpTokenEndpoint(broker, server.oauth.id, server.url).request(
        new NoSimulationTask("initial-auth-grant", false),
        AbortSignal.timeout(20_000),
      );
      output({
        phase: "grant",
        server: name,
        status: grant.isOk() ? "connected" : grant.error.code,
        ...(grant.isOk() ? { generation: grant.value.generation } : {}),
      });
      if (grant.isErr()) return err(failure("grant", "grant_unavailable"));
      const started = performance.now();
      const result = await safe(
        () =>
          definition.execute(
            "qualification",
            calls[name].input,
            AbortSignal.timeout(20_000),
            undefined,
            undefined as never,
          ),
        "read",
        "execute_failed",
      );
      if (result.isErr()) return result;
      const summary = summarizeCall(
        name,
        calls[name].tool,
        result.value,
        Math.round(performance.now() - started),
      );
      const application =
        name === "cloudflare"
          ? summarizeCloudflareRead(result.value)
          : summarizeDatadogRead(result.value);
      output({ phase: "read", server: name, sessionId, ...summary, application });
      if (
        summary.status !== "ok" ||
        (name === "cloudflare"
          ? application.apiSuccess !== true || application.apiStatus !== 200
          : application.outcome !== "success")
      )
        return err(failure("read", "application_unverified"));
    }
    output({ phase: "states", events });
    return ok(undefined);
  } finally {
    if (session) {
      const closing = session;
      await safe(
        () => closing.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        "session",
        "shutdown_failed",
      );
      closing.dispose();
    }
    await safe(() => rm(dir.value, { recursive: true, force: true }), "session", "cleanup_failed");
  }
}
