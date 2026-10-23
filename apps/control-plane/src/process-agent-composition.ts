import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Agent,
  createRegistry,
  type Extension,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type AuthProvider, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { McpConfig } from "@pi-orb/protocol";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { NativeResourceContext } from "./adapters/durable/context-storage.ts";
import { executionWaitProgress } from "./adapters/durable/execution-wait-progress.ts";
import type { DurableAgentPlaneOptions } from "./adapters/durable/manager.ts";
import { durableError } from "./adapters/durable/manager.ts";
import { fenceModels } from "./adapters/durable/model-fence.ts";
import { createDurableModels } from "./adapters/durable/models.ts";
import type { ParentNotification } from "./adapters/durable/notifications.ts";
import { loadPlatformResources } from "./adapters/durable/platform-resources.ts";
import { renderPrompt } from "./adapters/durable/prompt.ts";
import {
  type PersistedPlatformContext,
  prepareResourceContext,
} from "./adapters/durable/resource-context.ts";
import { createAgentToolFiles } from "./adapters/durable/tool-files.ts";
import { createDurableTools, type ToolError } from "./adapters/durable/tools/index.ts";
import { McpAdapterFailure } from "./adapters/durable/tools/mcp.ts";
import { createOrbTools } from "./adapters/durable/tools/orb-tools.ts";
import { RemoteExecutionEnv } from "./adapters/execution-client/env.ts";
import { LazyExecutionEnv } from "./adapters/execution-client/lazy-env.ts";
import { LunaTurnSummarizer } from "./adapters/luna-summarizer.ts";
import { modelCall } from "./adapters/model-usage.ts";
import type { PgResourceGate } from "./adapters/pg/resource-gate.ts";
import { CODEX_PROVIDER, getToken, type TokenGrant, type TokenRequest } from "./domain/broker.ts";
import type { RuntimeClientError } from "./domain/errors.ts";
import { awaitExecutionBinding, type ExecutionBinding } from "./domain/execution-admission.ts";
import { admitAgentRecovery } from "./domain/lifecycle.ts";
import { logOrbEvent } from "./domain/log.ts";
import type { McpStore } from "./domain/mcp.ts";
import type { McpOAuth } from "./domain/mcp-oauth.ts";
import type { ModelCallUse, ModelUsageLedger } from "./domain/model-usage.ts";
import {
  createCentralOrbAgentOperations,
  type OrbAgentError,
} from "./domain/orb-agent-operations.ts";
import type { BrokerDeps, ControlPlaneDeps } from "./domain/ports.ts";
import { getProjectSecretSnapshot } from "./domain/project-secrets.ts";
import { resourceError } from "./domain/resources.ts";

/** Composition owns durable projection and operational edges, not the guest. */
export function processAgentContext(
  _deps: ControlPlaneDeps,
  open: DurableAgentPlaneOptions["openContext"],
): DurableAgentPlaneOptions["openContext"] {
  return (task, orb, context, readOnly, lease) =>
    open(task, orb, context, readOnly, lease).map((options) => ({
      ...options,
      edge: (code, facts) => {
        logOrbEvent(task, orb.id, code, { ...facts, processId: process.pid });
        return options.edge?.(code, facts) ?? okAsync(undefined);
      },
    }));
}

export function mcpFetchSignal(
  caller?: AbortSignal,
  transport?: AbortSignal | null,
): AbortSignal | null {
  return caller && transport ? AbortSignal.any([caller, transport]) : (caller ?? transport ?? null);
}

export function scopedMcpHeaders(
  bindings: McpConfig["headers"],
  values: Readonly<Record<string, string>>,
): Result<Record<string, string>, ToolError> {
  const headers: Record<string, string> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    if ("literal" in binding) headers[name] = binding.literal;
    else {
      const value = values[binding.secret];
      if (value === undefined)
        return err({ code: "unavailable", message: "MCP secret unavailable" });
      headers[name] = `${binding.prefix ?? ""}${value}`;
    }
  }
  return ok(headers);
}

export function processAgentSystemContext(userTimeZone: string | null): string {
  return [
    "Use codemode to compose tool calls.",
    ...(userTimeZone
      ? [
          `User’s time zone: ${userTimeZone}. Present dates and times in this time zone unless they request another.`,
        ]
      : []),
  ].join("\n\n");
}

export function refreshProcessTools(
  tool: ToolRegistration,
  currentAgent: (api: ToolExecutionApi, context: Context) => ResultAsync<Agent, ToolError>,
): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const agent = await currentAgent(api, context);
      if (agent.isErr())
        return { isError: true, output: [{ type: "text", text: "Tool catalog unavailable" }] };
      return tool.execute(args, { ...api, agent: async () => agent.value }, context);
    },
  };
}

export function scopedMcpAuth(
  token: (request: TokenRequest) => ResultAsync<TokenGrant, ToolError>,
  onState?: (state: "needs-auth" | "available" | "unavailable") => void,
): AuthProvider {
  let last: TokenGrant | undefined;
  const resolve = async (request: TokenRequest) => {
    const grant = await token(request);
    // MCP's AuthProvider requires rejection; McpTools catches it at its adapter boundary.
    if (grant.isErr()) {
      onState?.(grant.error.code === "forbidden" ? "needs-auth" : "unavailable");
      return Promise.reject(
        new McpAdapterFailure(
          grant.error.code === "forbidden" ? "auth_required" : "unavailable",
          "credential",
        ),
      );
    }
    onState?.("available");
    last = grant.value;
    return grant.value.accessToken;
  };
  return {
    token: () => resolve({ reason: "startup" }),
    onUnauthorized: async ({ token: rejected }) => {
      if (last && rejected === last.accessToken)
        await resolve({ reason: "rejected", staleGeneration: last.generation });
    },
  };
}

export function closeProcessAgentResources(
  tools: { close: () => ResultAsync<void, ToolError> },
  env: { cleanup: (context: typeof BACKGROUND_CONTEXT) => Promise<void> },
): ResultAsync<void, RuntimeClientError> {
  return ResultAsync.combine([
    tools.close().mapErr((error) => durableError(error.message)),
    ResultAsync.fromPromise(env.cleanup(BACKGROUND_CONTEXT), () =>
      durableError("execution cleanup failed"),
    ),
  ]).map(() => undefined);
}

export function createProcessAgentContext(
  deps: ControlPlaneDeps,
  options: {
    brokerForUser: (userId: string) => BrokerDeps;
    resources: Pick<PgResourceGate, "acquire">;
    mcp: McpStore;
    mcpOAuth: McpOAuth;
    modelUsage: ModelUsageLedger;
    appOrigin: string;
    tailnetDnsName?: string;
    inferenceBaseUrl?: (userId: string) => string | undefined;
    notifyParent?: (
      orbId: string,
      expectedAdmissionVersion: number,
      ...args: Parameters<ParentNotification>
    ) => ReturnType<ParentNotification>;
    appendAlert: (
      orbId: string,
      requestId: string,
      message: string,
      expectedAdmissionVersion: number,
    ) => ResultAsync<{ recordId: string }, OrbAgentError>;
  },
): DurableAgentPlaneOptions["openContext"] {
  const open: DurableAgentPlaneOptions["openContext"] = (
    task,
    orb,
    incoming,
    readOnly = false,
    lease,
  ) => {
    const operation = {
      signal: lease ? AbortSignal.any([incoming.signal, lease.signal]) : incoming.signal,
    };
    const context = withAbortSignal(operation.signal, BACKGROUND_CONTEXT);
    const run = async () => {
      if (operation.signal.aborted)
        return err({ ...durableError("agent composition cancelled"), code: "cancelled" as const });
      const project = await deps.store.getProject(task, orb.projectId);
      if (project.isErr() || project.value === null)
        return err(durableError("orb project unavailable", true));
      const ownerUserId = project.value.ownerUserId;
      const personal = await deps.personalInstructions.read(task, ownerUserId);
      if (personal.isErr()) return err(durableError(personal.error.message, true));
      const projectInstructions = await deps.projectInstructions.read(task, orb.projectId);
      if (projectInstructions.isErr())
        return err(durableError(projectInstructions.error.message, true));
      if (!lease?.artifacts) return err(durableError("Agent resource authority unavailable"));
      const nativeContext = new NativeResourceContext(lease.storage, () =>
        lease.check().mapErr(() => resourceError("cancelled", "Resource ownership revoked")),
      );
      let platformSnapshot: PersistedPlatformContext | null = null;
      const prepared = await prepareResourceContext({
        signal: operation.signal,
        platformVersion: "pi-orb-platform-1",
        acquisition: { acquire: () => options.resources.acquire(task, orb, operation) },
        managed: () => okAsync({ personal: personal.value, project: projectInstructions.value }),
        platformStore: {
          get: () =>
            nativeContext.platform().map((value) => {
              platformSnapshot = value;
              return value;
            }),
          put: (value) => {
            platformSnapshot = value;
            return okAsync(undefined);
          },
        },
        loadPlatform: () =>
          loadPlatformResources(
            fileURLToPath(new URL("../../orb-runtime/skills/", import.meta.url)),
          ),
        check: () =>
          lease.check().mapErr(() => resourceError("cancelled", "Resource ownership revoked")),
        checkpoint: () =>
          ResultAsync.fromPromise(
            task.checkpoint("resource context publication", orb.id, orb.agentAdmissionVersion),
            () => resourceError("cancelled", "Resource context cancelled"),
          ),
      });
      if (prepared.isErr() || !platformSnapshot)
        return err(durableError("Required resource context unavailable"));
      const saved = await nativeContext.save(platformSnapshot, prepared.value.managed);
      if (saved.isErr()) return err(durableError("Resource context publication unavailable"));
      const instructions = renderPrompt({
        personal: personal.value.content,
        project: projectInstructions.value.content,
        repository: prepared.value.instructions,
        skills: prepared.value.skills,
        appendSystem: processAgentSystemContext(orb.userTimeZone),
      });
      const resourcesAbort = new AbortController();
      lease?.signal.addEventListener("abort", () => resourcesAbort.abort(), { once: true });
      const loadReady = (
        binding: ExecutionBinding & { release?: () => void },
        ctx: Context,
        requireRunning: boolean,
      ) => {
        const remote = new RemoteExecutionEnv(binding);
        const cleanup = remote.cleanup.bind(remote);
        remote.cleanup = async (cleanupContext) => {
          try {
            await cleanup(cleanupContext);
          } finally {
            binding.release?.();
          }
        };
        return ResultAsync.fromSafePromise(remote.ready(ctx))
          .andThen((ready) => {
            if (ready.isErr()) return err(durableError("Execution readiness unavailable."));
            if (ctx.abortSignal?.aborted || ready.value.incarnation !== binding.incarnation)
              return err({
                ...durableError("execution wait cancelled"),
                code: "cancelled" as const,
              });
            return deps.store
              .getOrb(task, orb.id)
              .mapErr(() => durableError("execution admission unavailable"))
              .andThen((current) => {
                if (
                  ctx.abortSignal?.aborted ||
                  !current ||
                  (requireRunning
                    ? current.state !== "running" &&
                      !(
                        current.state === "archiving" &&
                        deps.agentPlane?.session(orb.id)?.workActive?.() === true &&
                        !deps.control.isStopping(orb.id, current.stateVersion)
                      )
                    : !["creating", "starting", "running"].includes(current.state)) ||
                  String(current.hostIncarnation) !== binding.incarnation ||
                  current.agentAdmissionVersion !== orb.agentAdmissionVersion ||
                  current.stopReason === "manual" ||
                  current.stopReason === "sleep"
                )
                  return err(durableError("execution admission changed"));
                remote.cwd = ready.value.cwd;
                env.cwd = ready.value.cwd;
                return ok(remote);
              });
          })
          .orTee(() => binding.release?.());
      };
      const acquire = (ctx: Context, waiting?: () => ResultAsync<void, RuntimeClientError>) =>
        awaitExecutionBinding(
          task,
          deps,
          orb.id,
          {
            signal: ctx.abortSignal ?? resourcesAbort.signal,
          },
          orb.agentAdmissionVersion,
          waiting,
        ).andThen((binding) => loadReady(binding, ctx, true));
      const checkExecutionReady = (ctx: Context) =>
        deps.store
          .getOrb(task, orb.id)
          .mapErr(() => durableError("execution readiness unavailable"))
          .andThen((current) => {
            if (
              !current ||
              current.hostRef === null ||
              current.agentAdmissionVersion !== orb.agentAdmissionVersion ||
              !deps.hostProvider.executionBinding
            )
              return err(durableError("execution readiness admission changed"));
            return deps.hostProvider
              .executionBinding(
                task,
                { provider: deps.hostProvider.kind, resourceId: current.hostRef },
                { signal: ctx.abortSignal ?? resourcesAbort.signal },
              )
              .mapErr(() => durableError("execution readiness binding unavailable"))
              .andThen((binding) => loadReady(binding, ctx, false))
              .map(() => undefined);
          });
      const env = new LazyExecutionEnv({
        id: `orb:${orb.id}`,
        cwd: "",
        acquire,
        validate: (bound) =>
          (lease?.check() ?? okAsync(undefined)).andThen(() =>
            deps.store
              .getOrb(task, orb.id)
              .mapErr(() => durableError("execution admission unavailable"))
              .andThen((current) =>
                current &&
                bound instanceof RemoteExecutionEnv &&
                current.agentAdmissionVersion === orb.agentAdmissionVersion &&
                String(current.hostIncarnation) === bound.incarnation &&
                current.stopReason !== "manual" &&
                current.stopReason !== "sleep" &&
                (current.state === "running" ||
                  (current.state === "stopping" && current.stopReason === "idle") ||
                  (current.state === "archiving" &&
                    !deps.control.isStopping(orb.id, current.stateVersion)))
                  ? ok(undefined)
                  : err(durableError("execution admission revoked")),
              ),
          ),
      });
      const catalog = await options.mcp.read(task, orb.projectId);
      if (catalog.isErr()) return err(durableError(catalog.error.message, true));
      const inferenceBaseUrl = options.inferenceBaseUrl?.(ownerUserId);
      const models = await createDurableModels({
        signal: operation.signal,
        token: (signal) =>
          ResultAsync.fromSafePromise(
            getToken(
              task,
              options.brokerForUser(ownerUserId),
              CODEX_PROVIDER,
              {
                reason: "startup",
              },
              signal === undefined
                ? undefined
                : {
                    signal,
                    deadlineAt:
                      task.monotonicNow() +
                      options.brokerForUser(ownerUserId).constants.requestDeadlineMs,
                  },
            ),
          )
            .andThen((result) => result)
            .mapErr(() => durableError("owner model credential unavailable", true)),
        ...(inferenceBaseUrl ? { inferenceBaseUrl } : {}),
      });
      if (models.isErr()) return err(models.error);
      const service = createCentralOrbAgentOperations(
        task,
        deps,
        {
          ownerUserId,
          projectId: orb.projectId,
          orbId: orb.id,
          agentAdmissionVersion: orb.agentAdmissionVersion,
        },
        options,
      );
      let workspaceReady = false;
      const files = createAgentToolFiles({
        reader: prepared.value.reader,
        artifacts: lease.artifacts,
        allowSnapshotRead: () => !workspaceReady,
        check: () =>
          lease
            .check()
            .mapErr((): ToolError => ({ code: "forbidden", message: "Agent ownership revoked" })),
      });
      const notifyParent = options.notifyParent;
      const tools = createDurableTools({
        mcpDiscovery: {
          now: () => task.monotonicNow(),
          record: (failure) =>
            logOrbEvent(task, orb.id, "durable.mcp_discovery", {
              processId: process.pid,
              admission_version: orb.agentAdmissionVersion,
              server: failure.server,
              phase: failure.phase,
              outcome: failure.outcome,
              phase_elapsed_ms: failure.elapsedMs,
              discovery_elapsed_ms: failure.discoveryElapsedMs,
              errorCategory: failure.errorCategory,
              failure_stage: failure.failureStage,
              http_status: failure.httpStatus,
            }),
        },
        orb: { id: orb.id, task },
        files: {
          read: (request, api, ctx) =>
            deps.store
              .getOrb(task, orb.id)
              .mapErr(
                (): ToolError => ({
                  code: "unavailable",
                  message: "Resource readiness unavailable",
                }),
              )
              .andThen((current) => {
                workspaceReady =
                  current?.state === "running" &&
                  current.agentAdmissionVersion === orb.agentAdmissionVersion;
                return files.read(request, api, ctx);
              }),
          spill: files.spill,
        },
        authorize: () =>
          (lease?.check() ?? okAsync(undefined)).mapErr(
            (): ToolError => ({ code: "forbidden", message: "Agent ownership revoked" }),
          ),
        additionalTools: createOrbTools(
          service,
          notifyParent
            ? (message, api, ctx) =>
                notifyParent(orb.id, orb.agentAdmissionVersion, message, api, ctx)
            : undefined,
        ),
        mcp: catalog.value.servers.map((server) => {
          let state: "needs-auth" | "available" | "unavailable" = "unavailable";
          return {
            name: server.name,
            unavailableState: () => (state === "needs-auth" ? "needs-auth" : "unavailable"),
            connect: (ctx) =>
              ResultAsync.fromThrowable(
                async () => {
                  const fetcher: typeof fetch = async (input, init) => {
                    const current = await deps.store.getProject(task, orb.projectId);
                    if (current.isErr() || current.value?.ownerUserId !== ownerUserId)
                      return new Response(null, { status: 403 });
                    const fresh = await options.mcp.read(task, orb.projectId);
                    const config = fresh.isOk()
                      ? fresh.value.servers.find((s) => s.name === server.name)
                      : undefined;
                    if (
                      !config ||
                      config.url !== server.url ||
                      config.oauth?.id !== server.oauth?.id
                    )
                      return new Response(null, { status: 409 });
                    const secrets = await getProjectSecretSnapshot(
                      task,
                      deps.projectSecrets,
                      orb.projectId,
                    );
                    if (secrets.isErr()) return new Response(null, { status: 503 });
                    const scoped = scopedMcpHeaders(config.headers, secrets.value.values);
                    if (scoped.isErr()) return new Response(null, { status: 503 });
                    const headers = new Headers(init?.headers);
                    for (const [name, value] of Object.entries(scoped.value))
                      headers.set(name, value);
                    if (lease && (await lease.check()).isErr())
                      return new Response(null, { status: 403 });
                    const signal = mcpFetchSignal(ctx.abortSignal, init?.signal);
                    const response = await ResultAsync.fromThrowable(
                      () => fetch(input, { ...init, headers, signal }),
                      () => new McpAdapterFailure(signal?.aborted ? "abort" : "network", "http"),
                    )();
                    // The Fetch contract rejects; McpTools catches the typed failure.
                    if (response.isErr()) return Promise.reject(response.error);
                    if (response.value.status === 401) state = "needs-auth";
                    return response.value;
                  };
                  const oauth = server.oauth;
                  const authProvider = oauth
                    ? scopedMcpAuth(
                        (request) =>
                          ResultAsync.fromSafePromise(
                            options.mcpOAuth.token(
                              task,
                              { projectId: orb.projectId, id: oauth.id, url: server.url },
                              request,
                              ctx.abortSignal ? { signal: ctx.abortSignal } : undefined,
                            ),
                          )
                            .andThen((result) => result)
                            .mapErr(
                              (error): ToolError => ({
                                code: error.code === "auth_required" ? "forbidden" : "unavailable",
                                message: "MCP credential unavailable",
                              }),
                            ),
                        (next) => {
                          state = next;
                        },
                      )
                    : undefined;
                  return new StreamableHttpTransport({
                    url: server.url,
                    fetch: fetcher,
                    ...(authProvider ? { authProvider } : {}),
                  });
                },
                (): ToolError => ({ code: "unavailable", message: "MCP transport unavailable" }),
              )(),
          };
        }),
      });
      const currentProject = await deps.store.getProject(task, orb.projectId);
      const admitted = await deps.store.getOrb(task, orb.id);
      if (
        currentProject.isErr() ||
        currentProject.value?.ownerUserId !== ownerUserId ||
        admitted.isErr() ||
        !admitted.value ||
        admitted.value.agentAdmissionVersion !== orb.agentAdmissionVersion ||
        admitted.value.state === "deleting" ||
        (admitted.value.state === "archiving" && !readOnly) ||
        admitted.value.state === "archived" ||
        operation.signal.aborted
      ) {
        resourcesAbort.abort();
        await closeProcessAgentResources(tools, env);
        return err(
          operation.signal.aborted
            ? { ...durableError("agent composition cancelled"), code: "cancelled" as const }
            : durableError("agent admission superseded"),
        );
      }
      const registry = createRegistry();
      let conversation: Harness["conversation"] | undefined;
      const currentAgent = (api: ToolExecutionApi, ctx: Context): ResultAsync<Agent, ToolError> =>
        ResultAsync.fromThrowable(
          async () => {
            installTools();
            const native = await conversation?.(api.conversationId, ctx);
            if (!native)
              return err<Agent, ToolError>({
                code: "unavailable",
                message: "Native conversation unavailable",
              });
            if (api.conversationId !== ROOT_CONVERSATION_ID)
              await native.configure(
                {
                  tools: tools.childExtension.tools ?? [],
                  modelTools: (tools.childExtension.tools ?? []).filter(
                    (tool) => tool.name === "codemode",
                  ),
                },
                ctx,
              );
            return ok<Agent, ToolError>(await native.agent(ctx));
          },
          (): ToolError => ({ code: "unavailable", message: "Native tool refresh unavailable" }),
        )().andThen((result) => result);
      const instrument = (extension: Extension): Extension => ({
        ...extension,
        tools: (extension.tools ?? []).map((tool) =>
          (() => {
            const registration =
              tool.name === "codemode" ? refreshProcessTools(tool, currentAgent) : tool;
            return {
              ...registration,
              execute: async (args, api, ctx) => {
                let waited = false;
                let failed = true;
                const progressApi = executionWaitProgress(api, ctx, (phase) => {
                  if (phase === "waiting") waited = true;
                  if (waited || phase === "failed" || phase === "cancelled")
                    logOrbEvent(task, orb.id, `execution.tool_${phase}`, {
                      task_id: String(api.taskId),
                      call_id: api.callId,
                    });
                });
                try {
                  const result = await registration.execute(args, progressApi, ctx);
                  failed = result.isError === true;
                  return result;
                } finally {
                  await api.env?.cleanup(BACKGROUND_CONTEXT);
                  if (
                    waited ||
                    (failed && api.env instanceof LazyExecutionEnv && api.env.attempted())
                  )
                    logOrbEvent(task, orb.id, "execution.tool_wait_finished", {
                      task_id: String(api.taskId),
                      call_id: api.callId,
                      outcome: ctx.abortSignal?.aborted
                        ? "cancelled"
                        : failed
                          ? "failed"
                          : "completed",
                    });
                }
              },
            } satisfies ToolRegistration;
          })(),
        ),
      });
      const installTools = () => {
        registry.install(instrument(tools.extension));
        registry.install(instrument(tools.childExtension));
      };
      installTools();
      const recordModelCall = (use: ModelCallUse, response: AssistantMessage) =>
        options.modelUsage.record(task, modelCall({ ownerUserId, orbId: orb.id, use }, response));
      const summaryModel = models.value.getModel(CODEX_PROVIDER, "gpt-6-luna");
      return ok({
        env,
        models: models.value,
        ...(orb.initialModel === null
          ? {}
          : {
              initialSettings: { model: orb.initialModel, thinkingLevel: "high" as const },
            }),
        recordModelCall,
        ...(summaryModel
          ? {
              turnSummary: {
                task,
                summarizer: new LunaTurnSummarizer(
                  lease ? fenceModels(models.value, lease.check, lease.signal) : models.value,
                  summaryModel,
                  (response) => recordModelCall("turn_summary", response),
                ),
              },
            }
          : {}),
        registry,
        bindNativeConversation: (resolve: Harness["conversation"]) => {
          conversation = resolve;
        },
        modelTools: tools.modelTools,
        childExtension: tools.childExtension,
        checkoutCommit: prepared.value.commitSha,
        checkExecutionReady,
        executionActive: () => env.active(),
        resume: !readOnly && orb.stopReason !== "manual" && orb.stopReason !== "sleep",
        openSignal: operation.signal,
        admitRecovery: () => admitAgentRecovery(task, deps, orb.id),
        checkAdmission: () =>
          deps.store
            .getOrb(task, orb.id)
            .mapErr(() => durableError("agent admission unavailable"))
            .andThen((current) =>
              current &&
              current.agentAdmissionVersion === orb.agentAdmissionVersion &&
              current.state !== "deleting" &&
              current.state !== "archived" &&
              (orb.stopReason === "manual" || orb.stopReason === "sleep"
                ? current.stopReason === orb.stopReason
                : current.stopReason !== "manual" && current.stopReason !== "sleep")
                ? ok(undefined)
                : err(durableError("agent admission superseded")),
            ),
        envFor: () => env.invocation(),
        instructionSnapshots: { personal: personal.value, project: projectInstructions.value },
        instructions,
        closeResources: () => {
          resourcesAbort.abort();
          return closeProcessAgentResources(tools, env);
        },
      });
    };
    return ResultAsync.fromPromise(run(), () =>
      durableError("central agent composition failed", true),
    ).andThen((result) => result);
  };
  return processAgentContext(deps, open);
}
