import type { ClientAction, RequestResultFrame } from "@pi-orb/protocol";

export type RequestResult = RequestResultFrame["result"];

/** What the request gate can see of the agent at decision time. */
export interface AgentGateView {
  readonly activity: "idle" | "busy";
  readonly headId: string | null;
  readonly activeOperationId: string | null;
}

export type RequestDecision =
  | { readonly type: "start_message" }
  | { readonly type: "abort_operation"; readonly operationId: string }
  | {
      readonly type: "reject";
      readonly code: "busy" | "stale_head" | "stale_operation";
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Pure §6.3 request gate. All mutating requests pass through one serial
 * executor, so the view is consistent at decision time.
 */
export function decideRequest(view: AgentGateView, action: ClientAction): RequestDecision {
  switch (action.type) {
    case "message": {
      if (view.activity === "busy") {
        return {
          type: "reject",
          code: "busy",
          message: "an operation is in progress; steering is not supported in this slice",
          retryable: true,
        };
      }
      if (action.expectedHeadId !== view.headId) {
        return {
          type: "reject",
          code: "stale_head",
          message: `expected head ${JSON.stringify(action.expectedHeadId)} but head is ${JSON.stringify(view.headId)}`,
          retryable: false,
        };
      }
      return { type: "start_message" };
    }
    case "abort": {
      if (view.activeOperationId === null || view.activeOperationId !== action.operationId) {
        return {
          type: "reject",
          code: "stale_operation",
          message: `operation ${action.operationId} is not running`,
          retryable: false,
        };
      }
      return { type: "abort_operation", operationId: action.operationId };
    }
  }
}

export type RegistryLookup =
  | { readonly type: "new" }
  | { readonly type: "replay"; readonly result: RequestResult }
  | { readonly type: "conflict" };

function actionsEqual(a: ClientAction, b: ClientAction): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * In-memory request identity, scoped to one runtime process (§6.4). A resent
 * known ID with an identical action replays the original result with
 * `duplicate: true`; a known ID with a different action is a conflict. The map
 * lives for the life of the process; `server.welcome.runtimeInstanceId` tells
 * browsers when it has been emptied by a restart.
 */
export class RequestRegistry {
  private readonly byId = new Map<string, { action: ClientAction; result: RequestResult }>();

  lookup(requestId: string, action: ClientAction): RegistryLookup {
    const known = this.byId.get(requestId);
    if (known === undefined) return { type: "new" };
    if (!actionsEqual(known.action, action)) return { type: "conflict" };
    const result = known.result;
    if (result.type === "accepted") {
      return { type: "replay", result: { ...result, duplicate: true } };
    }
    return { type: "replay", result };
  }

  record(requestId: string, action: ClientAction, result: RequestResult): void {
    this.byId.set(requestId, { action, result });
  }
}
