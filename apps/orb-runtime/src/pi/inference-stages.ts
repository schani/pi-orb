import type { Agent } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Result } from "neverthrow";

export const INFERENCE_STAGES = [
  "turn_end_boundary",
  "next_turn_preparation",
  "request_projection",
  "context_hooks",
  "provider_preparation",
  "auth_resolution",
  "provider_headers",
  "provider_http",
] as const;

export interface InferenceStageAudit {
  operationId: string | null;
  sessionId: string;
  sequence: number;
  stage: (typeof INFERENCE_STAGES)[number];
  edge: "enter" | "exit";
  observedAt: number;
}

interface Dependencies {
  now(): number;
  identity(): Pick<InferenceStageAudit, "operationId" | "sessionId">;
  withIdentity?<R>(owner: ReturnType<Dependencies["identity"]>, run: () => R): R;
  audit(row: InferenceStageAudit): Result<void, { type: "stream_audit_failed" }>;
  failed(): void;
}

/** Decorate native hooks without changing their arguments, results or rejection contract. */
export function installInferenceStages(
  agent: Agent,
  deps: Dependencies,
  runtime?: Pick<ModelRuntime, "getAuth">,
): void {
  let sequence = 0;
  const rootSignals = new WeakMap<AbortSignal, ReturnType<Dependencies["identity"]>>();
  const wrap =
    <A extends unknown[], R>(
      stage: InferenceStageAudit["stage"],
      hook: (...args: A) => R | Promise<R>,
      owner?: ReturnType<Dependencies["identity"]>,
    ): ((...args: A) => Promise<R>) =>
    async (...args) => {
      const identity = { ...(owner ?? deps.identity()), sequence: ++sequence, stage };
      const record = (edge: InferenceStageAudit["edge"]): void => {
        if (deps.audit({ ...identity, edge, observedAt: deps.now() }).isErr()) deps.failed();
      };
      record("enter");
      // The SDK owns this callback's rejection contract; no error reaches domain code here.
      try {
        return await hook(...args);
      } finally {
        record("exit");
      }
    };
  if (agent.finishTurn) {
    const hook = wrap("turn_end_boundary", agent.finishTurn.bind(agent));
    agent.finishTurn = async (...args) => (await hook(...args)) ?? undefined;
  }
  if (agent.prepareNextTurnWithContext)
    agent.prepareNextTurnWithContext = wrap(
      "next_turn_preparation",
      agent.prepareNextTurnWithContext.bind(agent),
    );
  if (agent.prepareRequest) {
    const hook = wrap("request_projection", agent.prepareRequest.bind(agent));
    agent.prepareRequest = async (...args) => (await hook(...args)) ?? undefined;
  }
  if (agent.transformContext)
    agent.transformContext = wrap("context_hooks", agent.transformContext.bind(agent));
  const stream = wrap("provider_preparation", agent.streamFunction.bind(agent));
  agent.streamFunction = (...args) => {
    const owner = { ...deps.identity() };
    const options = args[2];
    if (options?.signal) rootSignals.set(options.signal, owner);
    const fetch = wrap("provider_http", options?.fetch ?? globalThis.fetch, owner);
    const run = () => stream(args[0], args[1], { ...options, fetch });
    return deps.withIdentity ? deps.withIdentity(owner, run) : run();
  };
  if (runtime) {
    const auth = runtime.getAuth.bind(runtime);
    const resolveAuth = (
      provider: string | Parameters<ModelRuntime["getAuth"]>[0],
      overrides?: Parameters<ModelRuntime["getAuth"]>[1],
    ) => (typeof provider === "string" ? auth(provider, overrides) : auth(provider, overrides));
    runtime.getAuth = (provider, overrides) => {
      const owner = overrides?.signal && rootSignals.get(overrides.signal);
      return owner
        ? wrap("auth_resolution", resolveAuth, owner)(provider, overrides)
        : resolveAuth(provider, overrides);
    };
  }
}
