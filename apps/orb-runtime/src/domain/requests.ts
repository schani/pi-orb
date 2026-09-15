import type { ClientAction, RequestResultFrame } from "@pi-orb/protocol";

export type RequestResult = RequestResultFrame["result"];

/** What the request gate can see of the agent at decision time. */
export interface AgentGateView {
  readonly acceptingWork: boolean;
  readonly activity: "idle" | "busy";
  readonly headId: string | null;
  readonly activeOperationId: string | null;
  readonly configuring?: boolean;
}

export type RequestDecision =
  | { readonly type: "change_settings" }
  | { readonly type: "start_message" }
  | { readonly type: "start_shell" }
  | { readonly type: "abort_operation"; readonly operationId: string }
  | {
      readonly type: "reject";
      readonly code: "busy" | "stale_head" | "stale_operation";
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Pure docs/runtime-protocol.md request gate. All mutating requests pass through one serial
 * executor, so the view is consistent at decision time.
 */
export function decideRequest(view: AgentGateView, action: ClientAction): RequestDecision {
  if (!view.acceptingWork)
    return {
      type: "reject",
      code: "busy",
      message: "runtime is preparing to stop",
      retryable: true,
    };
  if (view.configuring && action.type !== "abort")
    return {
      type: "reject",
      code: "busy",
      message: "Agent settings are changing.",
      retryable: true,
    };
  switch (action.type) {
    case "set_model":
    case "set_thinking":
      return view.activity === "idle"
        ? { type: "change_settings" }
        : {
            type: "reject",
            code: "busy",
            message: "Wait for the current operation to finish.",
            retryable: true,
          };
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
    case "shell": {
      if (view.activity === "busy") {
        return {
          type: "reject",
          code: "busy",
          message: "an operation is in progress; shell commands require an idle runtime",
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
      return { type: "start_shell" };
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
  | { readonly type: "pending"; readonly result: Promise<RequestResult> }
  | { readonly type: "replay"; readonly result: RequestResult }
  | { readonly type: "conflict" };

function actionsEqual(a: ClientAction, b: ClientAction): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * In-memory request identity, scoped to one runtime process (docs/runtime-protocol.md). A resent
 * known ID with an identical action replays the original result with
 * `duplicate: true`; a known ID with a different action is a conflict. The map
 * lives for the life of the process; `server.welcome.runtimeInstanceId` tells
 * browsers when it has been emptied by a restart.
 */
export class RequestRegistry {
  private readonly byId = new Map<string, { action: ClientAction; result: RequestResult }>();
  private readonly pending = new Map<
    string,
    {
      action: ClientAction;
      result: Promise<RequestResult>;
      resolve: (result: RequestResult) => void;
    }
  >();

  reserve(requestId: string, action: ClientAction): void {
    let resolve: (result: RequestResult) => void = () => {};
    const result = new Promise<RequestResult>((done) => {
      resolve = done;
    });
    this.pending.set(requestId, { action, result, resolve });
  }

  lookup(requestId: string, action: ClientAction): RegistryLookup {
    const pending = this.pending.get(requestId);
    if (pending)
      return actionsEqual(pending.action, action)
        ? { type: "pending", result: pending.result }
        : { type: "conflict" };
    const known = this.byId.get(requestId);
    if (known === undefined) return { type: "new" };
    if (!actionsEqual(known.action, action)) return { type: "conflict" };
    const result = known.result;
    if (result.type === "accepted" || result.type === "settings_applied") {
      return { type: "replay", result: { ...result, duplicate: true } };
    }
    return { type: "replay", result };
  }

  record(requestId: string, action: ClientAction, result: RequestResult): void {
    this.byId.set(requestId, { action, result });
    this.pending
      .get(requestId)
      ?.resolve(result.type === "rejected" ? result : { ...result, duplicate: true });
    this.pending.delete(requestId);
  }
}
