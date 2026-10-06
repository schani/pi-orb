import type { SimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import type { AgentPlane } from "./agent-ports.ts";
import type { RuntimeClientError } from "./errors.ts";
import type { OrbRow } from "./orb.ts";
import type {
  ControlPlaneStore,
  DeliverMessageClientRequest,
  OperationContext,
  PullHistoryClientRequest,
} from "./ports.ts";

export function agentPlacement(plane: AgentPlane | undefined, orb: OrbRow) {
  return orb.harness === "claude" ? "host" : (plane?.placementFor?.(orb) ?? plane?.placement);
}

/** Pi placement is configurable; native Claude authority always stays on its host. */
export class HarnessAgentPlane implements AgentPlane {
  readonly placement: "central" | "host";
  private readonly pi: AgentPlane;
  private readonly host: AgentPlane;
  private readonly store: Pick<ControlPlaneStore, "getOrb">;
  constructor(pi: AgentPlane, host: AgentPlane, store: Pick<ControlPlaneStore, "getOrb">) {
    this.pi = pi;
    this.host = host;
    this.store = store;
    this.placement = pi.placement;
  }
  private select(orb: OrbRow) {
    return orb.harness === "claude" ? this.host : this.pi;
  }
  placementFor(orb: OrbRow) {
    return this.select(orb).placement;
  }
  health(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.select(orb).health(task, orb, context);
  }
  executionReady(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.select(orb).executionReady?.(task, orb, context) ?? okAsync(undefined);
  }
  executionActive(orbId: string) {
    return this.pi.executionActive?.(orbId) ?? false;
  }
  deliverMessage(
    task: SimulationTask,
    orb: OrbRow,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ) {
    return this.select(orb).deliverMessage(task, orb, request, context);
  }
  prepareIdleStop(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.select(orb).prepareIdleStop(task, orb, context);
  }
  pullHistory(
    task: SimulationTask,
    orb: OrbRow,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ) {
    return this.select(orb).pullHistory(task, orb, request, context);
  }
  private byId(task: SimulationTask, orbId: string) {
    return this.store
      .getOrb(task, orbId)
      .mapErr(
        (error): RuntimeClientError => ({
          type: "runtime_client_error",
          code: "unreachable",
          answered: false,
          retryable: true,
          message: error.message,
        }),
      )
      .map((orb) => (orb === null ? null : this.select(orb)));
  }
  suspend(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
    throughAdmissionVersion?: number,
  ) {
    return this.byId(task, orbId).andThen(
      (plane) =>
        plane?.suspend(task, orbId, context, throughAdmissionVersion) ?? okAsync(undefined),
    );
  }
  dispose(
    task: SimulationTask,
    orbId: string,
    deleteAuthority: boolean,
    context: OperationContext,
  ) {
    return this.byId(task, orbId).andThen(
      (plane) => plane?.dispose(task, orbId, deleteAuthority, context) ?? okAsync(undefined),
    );
  }
  readSession(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return (
      this.select(orb).readSession?.(task, orb, context) ??
      errAsync({
        type: "runtime_client_error" as const,
        code: "unreachable" as const,
        answered: false,
        retryable: true,
        message: "Host conversation requires runtime transport",
      })
    );
  }
  unload(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.select(orb).unload?.(task, orb, context) ?? okAsync(false);
  }
  session(orbId: string) {
    return this.pi.session(orbId);
  }
  close() {
    return this.pi
      .close()
      .andThen(() => (this.pi === this.host ? okAsync(undefined) : this.host.close()));
  }
}
