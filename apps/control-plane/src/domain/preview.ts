import type { PreviewError, PreviewTarget } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { withDeadline } from "./dst.ts";
import { logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps, OperationContext } from "./ports.ts";

export const PREVIEW_LEASE_MS = 15_000;
export const PREVIEW_REVALIDATE_MS = 5_000;
export const PREVIEW_VALIDATION_TIMEOUT_MS = 2_000;
export const PREVIEW_MAX_DURATION_MS = 60 * 60_000;
export interface PreviewRequest {
  readonly orbId: string;
  readonly port: number;
  readonly origin: string;
  readonly expiresAt: number;
}
export interface PreviewRoute {
  readonly target: PreviewTarget;
  readonly baseUrl: string;
  readonly runtimeTokenHash: string;
  readonly origin: string;
  readonly expiresAt: number;
}
export const previewError = (code: PreviewError["code"], message: string): PreviewError => ({
  type: "preview_error",
  code,
  message,
});

export interface PreviewIdentity {
  readonly baseUrl: string;
  readonly executionId: string;
  readonly runtimeInstanceId: string;
}
/** Which admission check denied a request, and how, for the `preview-admission-denied` edge. */
export interface PreviewAdmissionDenial {
  readonly check:
    | "request"
    | "authority"
    | "host_observe"
    | "runtime_health"
    | "lease"
    | "admission";
  readonly failure: "timeout" | "error" | "mismatch";
  readonly error: PreviewError;
}
const denied = (
  check: PreviewAdmissionDenial["check"],
  failure: PreviewAdmissionDenial["failure"],
  code: PreviewError["code"],
  message: string,
): Result<never, PreviewAdmissionDenial> =>
  err({ check, failure, error: previewError(code, message) });

export async function admitPreview(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  request: PreviewRequest,
): Promise<Result<PreviewRoute, PreviewError>> {
  const startedAt = task.monotonicNow();
  const result = await resolvePreview(task, deps, request);
  if (
    deps.control.noteCondition(`preview-admission:${request.orbId}:${request.port}`, result.isErr())
  ) {
    const denial = result.isErr() ? result.error : undefined;
    logOrbEvent(
      task,
      request.orbId,
      denial ? "preview-admission-denied" : "preview-admission-recovered",
      {
        port: request.port,
        reason: denial?.error.code,
        check: denial?.check,
        failure: denial?.failure,
        elapsedMs: denial ? Math.round(task.monotonicNow() - startedAt) : undefined,
      },
    );
  }
  return result.mapErr((denial) => denial.error);
}

export function previewCloseError(
  info: { code: number; reason: string } | null,
): PreviewError | null {
  if (info === null || info.code === 1000 || info.code === 1001 || info.code >= 3000) return null;
  return previewError(
    info.code === 1009 || info.code === 1013
      ? "capacity_exceeded"
      : info.code === 1008
        ? "forbidden"
        : "upstream_failed",
    "Preview WebSocket interrupted",
  );
}

export function recordPreviewTransport(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  route: PreviewRoute,
  phase: "connect" | "stream",
  error: PreviewError | null,
): void {
  // The runtime refused the signed target: the cached identity is stale.
  if (error?.code === "stale_target") deps.control.forgetPreviewIdentity(route.target.orbId);
  if (
    deps.control.noteCondition(
      `preview-transport:${route.target.orbId}:${route.target.port}`,
      error !== null,
    )
  ) {
    logOrbEvent(
      task,
      route.target.orbId,
      error === null ? "preview-transport-recovered" : "preview-transport-failed",
      {
        port: route.target.port,
        incarnation: route.target.incarnation,
        executionId: route.target.executionId,
        runtimeInstanceId: route.target.runtimeInstanceId,
        phase,
        reason: error?.code,
      },
    );
  }
}

async function resolvePreview(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  request: PreviewRequest,
): Promise<Result<PreviewRoute, PreviewAdmissionDenial>> {
  if (request.port === 8080)
    return denied("request", "mismatch", "reserved_port", "The runtime port cannot be exposed");
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)
    return denied("request", "mismatch", "invalid_request", "Invalid preview port");
  if (task.wallNow() >= request.expiresAt)
    return denied("request", "mismatch", "unauthenticated", "Preview session expired");
  await task.checkpoint("preview.authority-read");
  const authority = await deps.store.readPreviewAuthority(task, request);
  if (authority.isErr())
    return denied("authority", "error", "store_unavailable", "Preview authority unavailable");
  if (authority.value === null)
    return denied("authority", "mismatch", "orb_not_found", "Orb doesn't exist");
  const { orb, registration } = authority.value;
  if (
    orb.state !== "running" ||
    orb.hostDiscardThroughIncarnation !== null ||
    orb.hostRef === null ||
    orb.runtimeTokenHash === null ||
    deps.control.isStopping(orb.id, orb.stateVersion)
  )
    return denied("authority", "mismatch", "orb_unavailable", `Orb is ${orb.state}`);
  if (registration === null)
    return denied("authority", "mismatch", "port_not_registered", "Preview port isn't registered");
  if (deps.hostProvider.kind === "process")
    return denied(
      "request",
      "mismatch",
      "unsupported_provider",
      "Previews require isolated compute",
    );
  const hostRef = orb.hostRef;
  // The runtime verifies the exact signed target on every forwarded request, so
  // a stale identity fails closed with `stale_target`, which drops it
  // (`recordPreviewTransport`); `stateVersion` retires it on any transition.
  const identity = await deps.control.sharePreviewIdentity(
    orb.id,
    JSON.stringify([orb.stateVersion, hostRef, orb.hostIncarnation, orb.runtimeTokenHash]),
    task.monotonicNow(),
    PREVIEW_REVALIDATE_MS,
    () => validateCompute(task, deps, orb.id, hostRef, orb.hostIncarnation),
  );
  if (identity.isErr()) return err(identity.error);
  const route: PreviewRoute = {
    target: {
      orbId: orb.id,
      port: request.port,
      registrationId: registration.registrationId,
      incarnation: orb.hostIncarnation,
      executionId: identity.value.executionId,
      runtimeInstanceId: identity.value.runtimeInstanceId,
    },
    baseUrl: identity.value.baseUrl,
    runtimeTokenHash: orb.runtimeTokenHash,
    origin: request.origin,
    expiresAt: Math.min(request.expiresAt, task.wallNow() + PREVIEW_MAX_DURATION_MS),
  };
  await task.checkpoint("preview.before-protection");
  const protectedActivity = await protect(task, deps, route);
  if (protectedActivity.isErr())
    return err({
      check: "lease",
      failure: protectedActivity.error.code === "store_unavailable" ? "error" : "mismatch",
      error: protectedActivity.error,
    });
  await task.checkpoint("preview.transport-admission");
  if (deps.control.isStopping(orb.id, orb.stateVersion))
    return denied("admission", "mismatch", "orb_unavailable", "Orb admission closed");
  if (task.wallNow() >= route.expiresAt)
    return denied("admission", "mismatch", "unauthenticated", "Preview session expired");
  return ok(route);
}

async function validateCompute(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  hostRef: string,
  incarnation: number,
): Promise<Result<PreviewIdentity, PreviewAdmissionDenial>> {
  await task.checkpoint("preview.compute-validation");
  const failure = (context: OperationContext) =>
    context.signal.aborted ? ("timeout" as const) : ("error" as const);
  const observed = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview host observation",
    (context) =>
      deps.hostProvider
        .observe(task, { provider: deps.hostProvider.kind, resourceId: hostRef }, context)
        .mapErr(() => failure(context)),
  );
  if (observed.isErr())
    return denied(
      "host_observe",
      observed.error,
      "stale_target",
      "Preview compute is unavailable or replaced",
    );
  if (
    observed.value === null ||
    observed.value.state !== "running" ||
    observed.value.orbId !== orbId ||
    observed.value.incarnation !== incarnation ||
    observed.value.runtimeAddress === undefined
  )
    return denied(
      "host_observe",
      "mismatch",
      "stale_target",
      "Preview compute is unavailable or replaced",
    );
  const baseUrl = observed.value.runtimeAddress.baseUrl;
  const health = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview runtime identity",
    (context) => deps.runtimeClient.health(task, baseUrl, context).mapErr(() => failure(context)),
  );
  if (health.isErr())
    return denied(
      "runtime_health",
      health.error,
      "stale_target",
      "Preview runtime identity unavailable",
    );
  if (
    health.value.status !== "ready" ||
    health.value.orbId !== orbId ||
    health.value.incarnation !== incarnation ||
    !health.value.executionId
  )
    return denied(
      "runtime_health",
      "mismatch",
      "stale_target",
      "Preview runtime identity unavailable",
    );
  return ok({
    baseUrl,
    executionId: health.value.executionId,
    runtimeInstanceId: health.value.runtimeInstanceId,
  });
}

async function protect(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  route: PreviewRoute,
): Promise<Result<void, PreviewError>> {
  const protectedActivity = await deps.store.protectPreviewActivity(task, {
    orbId: route.target.orbId,
    port: route.target.port,
    registrationId: route.target.registrationId,
    hostIncarnation: route.target.incarnation,
    runtimeTokenHash: route.runtimeTokenHash,
    now: task.wallNow(),
    activeUntil: task.wallNow() + PREVIEW_LEASE_MS,
  });
  if (protectedActivity.isErr())
    return err(previewError("store_unavailable", "Preview activity protection unavailable"));
  if (protectedActivity.value.type !== "protected")
    return err(previewError("stale_target", "Preview admission closed"));
  return ok(undefined);
}

export async function revalidatePreview(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  route: PreviewRoute,
  active: boolean,
  signal?: AbortSignal,
): Promise<Result<void, PreviewError>> {
  if (task.wallNow() >= route.expiresAt)
    return err(previewError("unauthenticated", "Preview session or stream expired"));
  await task.checkpoint("preview.revalidation");
  const authority = await deps.store.readPreviewAuthority(task, {
    orbId: route.target.orbId,
    port: route.target.port,
  });
  if (authority.isErr())
    return err(previewError("store_unavailable", "Preview authority unavailable"));
  if (signal?.aborted)
    return err(previewError("deadline_exceeded", "Preview authority validation timed out"));
  const orb = authority.value?.orb;
  if (
    orb === undefined ||
    orb.state !== "running" ||
    orb.hostRef === null ||
    orb.hostDiscardThroughIncarnation !== null ||
    orb.hostIncarnation !== route.target.incarnation ||
    orb.runtimeTokenHash !== route.runtimeTokenHash ||
    authority.value?.registration?.registrationId !== route.target.registrationId ||
    deps.control.isStopping(orb.id, orb.stateVersion)
  )
    return err(previewError("stale_target", "Preview authority closed or replaced"));
  const hostRef = orb.hostRef;
  const observed = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview compute revalidation",
    (context) =>
      deps.hostProvider.observe(
        task,
        { provider: deps.hostProvider.kind, resourceId: hostRef },
        { signal: signal ?? context.signal },
      ),
  );
  if (
    observed.isErr() ||
    observed.value === null ||
    observed.value.state !== "running" ||
    observed.value.orbId !== route.target.orbId ||
    observed.value.incarnation !== route.target.incarnation ||
    observed.value.runtimeAddress?.baseUrl !== route.baseUrl
  )
    return err(previewError("stale_target", "Preview compute identity changed"));
  if (signal?.aborted)
    return err(previewError("deadline_exceeded", "Preview identity validation timed out"));
  const health = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview runtime revalidation",
    (context) =>
      deps.runtimeClient.health(task, route.baseUrl, { signal: signal ?? context.signal }),
  );
  if (
    health.isErr() ||
    health.value.status !== "ready" ||
    health.value.orbId !== route.target.orbId ||
    health.value.incarnation !== route.target.incarnation ||
    health.value.executionId !== route.target.executionId ||
    health.value.runtimeInstanceId !== route.target.runtimeInstanceId
  )
    return err(previewError("stale_target", "Preview runtime identity changed"));
  if (signal?.aborted)
    return err(previewError("deadline_exceeded", "Preview identity validation timed out"));
  if (deps.control.isStopping(orb.id, orb.stateVersion))
    return err(previewError("stale_target", "Preview admission closed"));
  return active ? protect(task, deps, route) : ok(undefined);
}
