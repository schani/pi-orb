import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import upstreamSubagents from "@gotgenes/pi-subagents/extension";
import type { McpCatalog } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { HttpBrokerEndpoint } from "../../../apps/orb-runtime/src/broker/endpoint.ts";
import { brokerProviderConfig } from "../../../apps/orb-runtime/src/broker/provider.ts";
import { BrokerTokenClient } from "../../../apps/orb-runtime/src/domain/broker-client.ts";
import { fetchMcpCatalog } from "../../../apps/orb-runtime/src/mcp/boot.ts";
import { createOrbMcpExtension } from "../../../apps/orb-runtime/src/mcp/native.ts";
import {
  activateCodemode,
  createOrbExtensions,
} from "../../../apps/orb-runtime/src/pi/extensions/index.ts";
import observer, { qualifiesMeasurement, successfulAssistant } from "./owned-context-observer.mjs";
import { failureDiagnostic, summarizeContextRecords } from "./owned-context-policy.mjs";
import { approvedWorkerTools, writeWorkerProfile } from "./owned-context-worker.mjs";

const orbId = "9675b61b-f1e9-404a-84d3-ad79e18cea61";
const approved = {
  cloudflare: ["https://mcp.cloudflare.com/mcp", "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b"],
  datadog: ["https://mcp.us5.datadoghq.com/v1/mcp", "c25b1857-1896-45cf-a427-a90cee36d125"],
} as const;
const metadataUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/pi-orb-config";
const stateKey = Symbol.for("pi-orb:owned-context-qualification");
const safe = <T>(fn: () => Promise<T>) =>
  ResultAsync.fromThrowable(fn, () => ({ status: "unavailable" as const }))();
type Measurement = {
  profile: string;
  phase: string;
  kind: string;
  status: string;
  utf8Bytes: number | null;
  codepoints: number | null;
  activeMcpToolCount: number;
  discovered: Record<string, number>;
  searched: Record<string, number>;
  deniedCalls: number;
  modelVerified: boolean;
  codemodeActive: boolean;
};
type State = {
  profile: string;
  rootSessionId: string;
  records: Measurement[];
  started: Set<string>;
  searches: Record<string, Record<string, number>>;
  denied: Record<string, number>;
  deniedCategories: Record<string, Record<string, number>>;
  deniedSearchShapes: Record<string, Record<string, boolean>>;
  modelVerified: Record<string, boolean>;
  discovered: Record<string, Record<string, number>>;
  completed: Record<string, boolean>;
};
const queries = ["cloudflare account", "datadog monitor"];
const searchedBoth = (state: State, profile: string) =>
  queries.every((query) => (state.searches[profile]?.[query] ?? 0) > 0);
const inventory = (counts: Record<string, number> | undefined, expected: number) =>
  counts?.cloudflare === (expected ? 3 : 0) && counts.datadog === (expected ? 33 : 0);
const payload = (state: State, profile: string, phase: string) =>
  state.records.some((record) => qualifiesMeasurement(record, profile, phase));
const promptSucceeded = (
  session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
) => successfulAssistant(session.messages.findLast((message) => message.role === "assistant"));
const boundedPrompt = (
  session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
  text: string,
) => {
  const timeout = setTimeout(() => session.abort(), 90_000);
  return safe(() => session.prompt(text).finally(() => clearTimeout(timeout)));
};

export function approvedCatalog(catalog: McpCatalog) {
  return (
    catalog?.revision === 1 &&
    catalog.servers?.length === 2 &&
    new Set(catalog.servers.map((server) => server.name)).size === 2 &&
    catalog.servers.every(
      (server) =>
        Object.hasOwn(approved, server.name) &&
        server.url === approved[server.name as keyof typeof approved][0] &&
        server.oauth?.id === approved[server.name as keyof typeof approved][1] &&
        Object.keys(server.headers ?? {}).length === 0,
    )
  );
}

function measured(state: State, profile: string) {
  return ["provider_payload", "transcript"].every((kind) =>
    state.records.some(
      (record) =>
        record.profile === profile && record.kind === kind && record.status === "measured",
    ),
  );
}

async function childDone(
  bus: ReturnType<typeof createEventBus>,
  service: NonNullable<ReturnType<typeof getSubagentsService>>,
  id: string,
) {
  return safe(
    () =>
      new Promise<string>((resolve) => {
        let settled = false;
        const finish = () => {
          const status = service.getRecord(id)?.status;
          if (!status || !["completed", "error", "stopped"].includes(status) || settled) return;
          settled = true;
          clearTimeout(timeout);
          offDone();
          offFailed();
          resolve(status);
        };
        const offDone = bus.on("subagents:completed", finish);
        const offFailed = bus.on("subagents:failed", finish);
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            offDone();
            offFailed();
            resolve("deadline");
          }
        }, 90_000);
        finish();
      }),
  );
}

async function run(expectedOrbId: string) {
  if (expectedOrbId !== orbId) return { status: "invalid_input" };
  const configResponse = await safe(() =>
    fetch(metadataUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (configResponse.isErr() || !configResponse.value.ok) return { status: "identity_unavailable" };
  const parsed = await safe(() => configResponse.value.json() as Promise<Record<string, unknown>>);
  if (parsed.isErr()) return { status: "identity_unavailable" };
  const identity = parsed.value;
  if (
    identity.PI_ORB_ID !== orbId ||
    typeof identity.PI_ORB_RUNTIME_TOKEN !== "string" ||
    !identity.PI_ORB_RUNTIME_TOKEN ||
    typeof identity.PI_ORB_CONTROL_PLANE_URL !== "string" ||
    !identity.PI_ORB_CONTROL_PLANE_URL
  )
    return { status: "identity_mismatch" };
  const broker = {
    controlPlaneUrl: identity.PI_ORB_CONTROL_PLANE_URL,
    runtimeToken: identity.PI_ORB_RUNTIME_TOKEN,
  };
  const catalog = await fetchMcpCatalog(broker);
  if (catalog.isErr() || !approvedCatalog(catalog.value)) return { status: "catalog_mismatch" };
  const dir = await safe(() => mkdtemp(join(tmpdir(), "owned-context-")));
  if (dir.isErr()) return { status: "workspace_unavailable" };
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(dir.value, "pi-agent");
  process.env.PI_CODING_AGENT_DIR = agentDir; // The child SDK resolves the same temporary private auth store.
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let service: ReturnType<typeof getSubagentsService>;
  const report: object[] = [];
  try {
    const runtime = await safe(() =>
      ModelRuntime.create({ authPath: join(agentDir, "auth.json"), allowModelNetwork: false }),
    );
    if (runtime.isErr()) return { status: "model_unavailable" };
    const modelRuntime = runtime.value;
    const settingsFile = await safe(async () => {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        { mode: 0o600 },
      );
    });
    if (settingsFile.isErr()) return { status: "workspace_unavailable" };
    modelRuntime.registerProvider(
      "openai-codex",
      brokerProviderConfig(
        new NoSimulationTask("owned-context-model", false),
        new BrokerTokenClient(new HttpBrokerEndpoint(broker, "model")),
        {},
      ),
    );
    const login = await safe(async () => {
      if (!(await modelRuntime.getAuth("openai-codex")))
        await modelRuntime.login("openai-codex", "oauth", {
          prompt: async (prompt) =>
            prompt.type === "select" && prompt.options[0] ? prompt.options[0].id : "",
          notify: () => {},
        });
      await modelRuntime.refresh({ allowNetwork: false });
    });
    if (login.isErr()) return { status: "model_auth_unavailable" };
    const model = modelRuntime.getModel("openai-codex", "gpt-6.1-sol");
    if (!model) return { status: "model_unavailable" };
    for (const [profile, servers] of [
      ["independent_empty_baseline", []],
      ["root", catalog.value.servers],
    ] as const) {
      const state: State = {
        profile,
        rootSessionId: "",
        records: [],
        started: new Set(),
        searches: {},
        denied: {},
        deniedCategories: {},
        deniedSearchShapes: {},
        modelVerified: {},
        discovered: {},
        completed: {},
      };
      (globalThis as Record<symbol, unknown>)[stateKey] = state;
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const bus = createEventBus();
      const mcp = createOrbMcpExtension({
        configs: servers,
        secrets: {},
        broker,
        task: new NoSimulationTask("owned-context-mcp", false),
      });
      if (profile === "root") {
        const previewSettings = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const previewLoader = new DefaultResourceLoader({
          cwd: dir.value,
          agentDir,
          settingsManager: previewSettings,
          extensionFactories: [
            ...createOrbExtensions({ cwd: dir.value, mcp }),
            {
              name: "qualification:preview-guard",
              factory: (pi) => {
                pi.on("tool_call", () => {
                  state.denied.root = (state.denied.root ?? 0) + 1;
                  return {
                    block: true,
                    terminate: true,
                    reason: "Qualification permits no model tool calls",
                  };
                });
              },
            },
          ],
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
        });
        let preview: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const prepared = await safe(async () => {
            await previewLoader.reload();
            if (previewLoader.getExtensions().errors.length) return false;
            const created = await createAgentSession({
              cwd: dir.value,
              agentDir,
              modelRuntime,
              model,
              settingsManager: previewSettings,
              resourceLoader: previewLoader,
              sessionManager: SessionManager.inMemory(),
            });
            preview = created.session;
            await preview.bindExtensions({});
            if (activateCodemode(preview).isErr()) return false;
            const prompted = await boundedPrompt(preview, "Answer only: ready. Do not call tools.");
            if (prompted.isErr() || !promptSucceeded(preview) || state.denied.root) return false;
            const names = approvedWorkerTools(preview.getAllTools(), true);
            if (!names) return false;
            await writeWorkerProfile(dir.value, names);
            return true;
          });
          if (prepared.isErr() || !prepared.value)
            return {
              status: "discovery_unavailable",
              diagnostic: failureDiagnostic(state, "root_discovery"),
            };
        } finally {
          if (preview) {
            const closing = preview;
            await safe(() =>
              closing.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
            );
            preview.dispose();
          }
        }
      } else {
        const written = await safe(() => writeWorkerProfile(dir.value, ["codemode"]));
        if (written.isErr())
          return {
            status: "workspace_unavailable",
            diagnostic: failureDiagnostic(state, "baseline_prompt"),
          };
      }
      const nativeExtensions = createOrbExtensions({ cwd: dir.value, mcp });
      const childExtensions = [
        ...nativeExtensions,
        { name: "qualification:observer", factory: observer },
      ];
      const loader = new DefaultResourceLoader({
        cwd: dir.value,
        agentDir,
        settingsManager: settings,
        eventBus: bus,
        extensionFactories: [
          {
            name: "qualification:subagents",
            factory: (pi) => upstreamSubagents(pi, { cwd: dir.value, childExtensions }),
          },
          ...childExtensions,
        ],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
      });
      let spawnedId: string | undefined;
      const failed = (status: string, stage: string, detail?: string) => ({
        status,
        ...(detail ? { profile: detail } : {}),
        diagnostic: failureDiagnostic(state, stage),
      });
      try {
        const loaded = await safe(() => loader.reload());
        if (loaded.isErr() || loader.getExtensions().errors.length)
          return failed(
            "extension_unavailable",
            profile === "root" ? "root_prompt" : "baseline_prompt",
          );
        const created = await safe(() =>
          createAgentSession({
            cwd: dir.value,
            agentDir,
            modelRuntime,
            model,
            settingsManager: settings,
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
          }),
        );
        if (created.isErr())
          return failed(
            "session_unavailable",
            profile === "root" ? "root_prompt" : "baseline_prompt",
          );
        session = created.value.session;
        state.rootSessionId = session.sessionManager.getSessionId();
        const bound = await safe(() => session!.bindExtensions({}));
        if (bound.isErr())
          return failed(
            "binding_unavailable",
            profile === "root" ? "root_prompt" : "baseline_prompt",
          );
        if (
          activateCodemode(session).isErr() ||
          !session.getActiveToolNames().includes("codemode") ||
          session.getActiveToolNames().includes("tool_search")
        )
          return failed(
            "executor_unavailable",
            profile === "root" ? "root_prompt" : "baseline_prompt",
          );
        const first = await boundedPrompt(
          session,
          profile === "root"
            ? "Answer only: ready. Do not call tools."
            : "Answer only: baseline. Do not call tools.",
        );
        if (first.isErr() || !promptSucceeded(session) || !state.completed[profile])
          return failed(
            "inference_unavailable",
            profile === "root" ? "root_prompt" : "baseline_prompt",
            profile,
          );
        if (
          !inventory(state.discovered[profile], profile === "root" ? 1 : 0) ||
          !payload(state, profile, profile === "root" ? "after_discovery" : "before_discovery")
        )
          return failed(
            profile === "root" ? "discovery_unavailable" : "baseline_not_empty",
            profile === "root" ? "root_discovery" : "baseline_discovery",
          );
        if (profile === "root") {
          const nativeSearch = session.getToolDefinition("tool_search");
          if (!nativeSearch) return failed("search_unavailable", "root_search_prompt");
          const executeSearch = nativeSearch.execute as (
            id: string,
            args: { query: string },
          ) => ReturnType<NonNullable<typeof nativeSearch>["execute"]>;
          for (const [query, namespace] of [
            ["cloudflare account", "cloudflare"],
            ["datadog monitor", "datadog"],
          ] as const) {
            const searched = await safe(() =>
              executeSearch(`owned-context-${namespace}`, { query }),
            );
            if (
              searched.isErr() ||
              !searched.value.content.some(
                (part) =>
                  part.type === "text" &&
                  /^Loaded [1-9][0-9]* tools\./.test(part.text) &&
                  part.text.includes(`mcp__${namespace}__`),
              )
            )
              return failed("search_unavailable", "root_search_prompt");
            state.searches.root ??= {};
            const counts = state.searches.root;
            counts[query] = (counts[query] ?? 0) + 1;
          }
          const after = await boundedPrompt(session, "Answer briefly. Do not call tools.");
          if (after.isErr() || !promptSucceeded(session) || !payload(state, "root", "after_search"))
            return failed("measurement_unavailable", "root_after_search", profile);
        }
        if (!measured(state, profile) || !state.started.has(profile))
          return failed(
            "measurement_unavailable",
            profile === "root" ? "root_after_search" : "baseline_discovery",
            profile,
          );
        service = getSubagentsService();
        if (!service)
          return failed(
            "child_service_unavailable",
            profile === "root" ? "root_child" : "baseline_child",
          );
        const childProfile = profile === "root" ? "child" : "baseline_child";
        const spawned = await safe(async () =>
          service!.spawn(
            "owned-context-worker",
            profile === "root"
              ? "Answer only: ready. Do not call tools."
              : "Answer only: baseline. Do not call tools.",
            {
              model: "openai-codex/gpt-6.1-sol",
              maxTurns: 3,
              inheritContext: false,
              foreground: false,
            },
          ),
        );
        if (spawned.isErr())
          return failed(
            "child_spawn_unavailable",
            profile === "root" ? "root_child" : "baseline_child",
          );
        spawnedId = spawned.value;
        const finished = await childDone(bus, service, spawned.value);
        if (
          finished.isErr() ||
          finished.value !== "completed" ||
          !state.started.has(childProfile) ||
          !measured(state, childProfile) ||
          !state.completed[childProfile] ||
          !inventory(state.discovered[childProfile], profile === "root" ? 1 : 0) ||
          !payload(state, childProfile, profile === "root" ? "after_discovery" : "before_discovery")
        )
          return failed("child_unavailable", profile === "root" ? "root_child" : "baseline_child");
        if (
          profile === "root" &&
          (!searchedBoth(state, "root") ||
            state.searches.child !== undefined ||
            !payload(state, "root", "after_discovery"))
        )
          return failed("search_unavailable", "root_child_search_gate");
        if (profile !== "root" && (state.searches[profile] || state.searches[childProfile]))
          return failed("baseline_not_empty", "baseline_gate");
        if (Object.values(state.denied).some((count) => count > 0))
          return failed("denied_calls", profile === "root" ? "root_gate" : "baseline_gate");
        for (const label of [profile, childProfile])
          report.push({
            profile: label,
            catalogCount: servers.length,
            exposedToolCount: Object.values(state.discovered[label] ?? {}).reduce(
              (a, b) => a + b,
              0,
            ),
            searchCount: Object.values(state.searches[label] ?? {}).reduce((a, b) => a + b, 0),
            searchActor: label === "root" ? "sdk_native_harness" : "none",
            deniedCalls: state.denied[label] ?? 0,
            metrics: summarizeContextRecords(
              state.records.filter((record) => record.profile === label),
            ),
          });
      } finally {
        if (service) {
          if (
            spawnedId &&
            !["completed", "error", "stopped"].includes(service.getRecord(spawnedId)?.status ?? "")
          )
            await safe(async () => {
              service!.abort(spawnedId!);
            });
          await safe(() => service!.waitForAll());
        }
        if (session) {
          await safe(() =>
            session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          );
          session.dispose();
          session = undefined;
        }
        service = undefined;
      }
    }
    return { status: "measured", model: "openai-codex/gpt-6.1-sol", report };
  } finally {
    delete (globalThis as Record<symbol, unknown>)[stateKey];
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await safe(() => rm(dir.value, { recursive: true, force: true }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2] ?? "").then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "measured") process.exitCode = 1;
    },
    () => {
      process.stdout.write('{"status":"unavailable"}\n');
      process.exitCode = 1;
    },
  );
}
