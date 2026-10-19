import type { SimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import type { OrbRow } from "./orb.ts";
import type {
  ControlPlaneDeps,
  DeliverMessageClientRequest,
  OperationContext,
  PullHistoryClientRequest,
} from "./ports.ts";

export function agentHealth(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  baseUrl: string,
  context: OperationContext,
) {
  return deps.agentPlane
    ? deps.agentPlane.health(task, orb, context)
    : deps.runtimeClient.health(task, baseUrl, context);
}

export function agentHistory(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  request: PullHistoryClientRequest,
  context: OperationContext,
) {
  return deps.agentPlane
    ? deps.agentPlane.pullHistory(task, orb, request, context)
    : deps.runtimeClient.pullHistory(task, request, context);
}

export function deliverAgentMessages(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  requests: readonly DeliverMessageClientRequest[],
  context: OperationContext,
) {
  return deps.agentPlane
    ? deps.agentPlane.deliverMessages(task, orb, requests, context)
    : ResultAsync.fromSafePromise(
        Promise.all(
          requests.map((request) => deps.runtimeClient.deliverMessage(task, request, context)),
        ),
      );
}

export function prepareAgentStop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  baseUrl: string,
  context: OperationContext,
) {
  return deps.agentPlane
    ? deps.agentPlane.prepareIdleStop(task, orb, context)
    : deps.runtimeClient.prepareIdleStop(task, baseUrl, context);
}

export function suspendAgent(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  context: OperationContext,
  throughAdmissionVersion?: number,
) {
  return (
    deps.agentPlane?.suspend(task, orbId, context, throughAdmissionVersion) ?? okAsync(undefined)
  );
}
