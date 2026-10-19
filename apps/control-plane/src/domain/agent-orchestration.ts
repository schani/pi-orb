import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "./errors.ts";
import { agentPlacement } from "./harness-agent-plane.ts";
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

export function deliverAgentMessage(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  request: DeliverMessageClientRequest,
  context: OperationContext,
) {
  return deps.agentPlane
    ? deps.agentPlane.deliverMessage(task, orb, request, context)
    : deps.runtimeClient.deliverMessage(task, request, context);
}

export function deliverAgentMessages(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  requests: readonly DeliverMessageClientRequest[],
  context: OperationContext,
) {
  const request = requests[0];
  if (requests.length === 1 && request)
    return ResultAsync.fromSafePromise(
      Promise.resolve(deliverAgentMessage(task, deps, orb, request, context)),
    ).map((response) => [response]);
  return agentPlacement(deps.agentPlane, orb) === "central" && deps.agentPlane?.deliverMessages
    ? deps.agentPlane.deliverMessages(task, orb, requests, context)
    : errAsync<never, RuntimeClientError>({
        type: "runtime_client_error",
        code: "invalid_response",
        answered: false,
        retryable: true,
        message: "Central backlog admission unavailable",
      });
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
