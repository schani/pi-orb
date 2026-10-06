import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { AgentPlane } from "../domain/agent-ports.ts";
import type { ControlState } from "../domain/control-state.ts";
import type { RuntimeClientError } from "../domain/errors.ts";
import type { OrbRow } from "../domain/orb.ts";
import type {
  DeliverMessageClientRequest,
  OperationContext,
  OrbHostProvider,
  OrbRuntimeClient,
  PullHistoryClientRequest,
} from "../domain/ports.ts";

const unavailable = (message: string, cancelled = false): RuntimeClientError => ({
  type: "runtime_client_error",
  answered: false,
  code: cancelled ? "cancelled" : "unreachable",
  message,
  retryable: true,
});

/** Guest SDK ownership remains with the authenticated runtime and host lifecycle. */
export class SdkAgentPlane implements AgentPlane {
  readonly placement = "host" as const;
  private readonly deps: {
    hostProvider: OrbHostProvider;
    runtimeClient: OrbRuntimeClient;
    control: Pick<ControlState, "noteRuntimeRequestStarted">;
  };
  constructor(deps: SdkAgentPlane["deps"]) {
    this.deps = deps;
  }
  private endpoint(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<string, RuntimeClientError> {
    if (context.signal.aborted) return errAsync(unavailable("SDK operation cancelled", true));
    if (orb.hostRef === null) return errAsync(unavailable("SDK host unavailable"));
    return this.deps.hostProvider
      .observe(task, { provider: this.deps.hostProvider.kind, resourceId: orb.hostRef }, context)
      .mapErr((error) => unavailable(error.message, error.code === "cancelled"))
      .andThen((host) => {
        if (context.signal.aborted) return errAsync(unavailable("SDK operation cancelled", true));
        if (
          !host ||
          host.incarnation !== orb.hostIncarnation ||
          host.state !== "running" ||
          !host.runtimeAddress
        )
          return errAsync(unavailable("SDK host incarnation unavailable"));
        return okAsync(host.runtimeAddress.baseUrl);
      });
  }
  health(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.endpoint(task, orb, context).andThen((url) =>
      this.deps.runtimeClient.health(task, url, context),
    );
  }
  deliverMessage(
    task: SimulationTask,
    orb: OrbRow,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ) {
    return this.endpoint(task, orb, context).andThen((baseUrl) => {
      this.deps.control.noteRuntimeRequestStarted(orb.id, task.monotonicNow());
      return this.deps.runtimeClient.deliverMessage(task, { ...request, baseUrl }, context);
    });
  }
  prepareIdleStop(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.endpoint(task, orb, context).andThen((url) =>
      this.deps.runtimeClient.prepareIdleStop(task, url, context),
    );
  }
  pullHistory(
    task: SimulationTask,
    orb: OrbRow,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ) {
    return this.endpoint(task, orb, context).andThen((baseUrl) => {
      this.deps.control.noteRuntimeRequestStarted(orb.id, task.monotonicNow());
      return this.deps.runtimeClient.pullHistory(task, { ...request, baseUrl }, context);
    });
  }
  suspend() {
    return okAsync<void, RuntimeClientError>(undefined);
  }
  dispose() {
    return okAsync<void, RuntimeClientError>(undefined);
  }
  session() {
    return null;
  }
  close() {
    return okAsync<void, RuntimeClientError>(undefined);
  }
}
