import type { PreviewError, PreviewTarget } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { withDeadline } from "./dst.ts";
import { logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps } from "./ports.ts";

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

export async function admitPreview(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  request: PreviewRequest,
): Promise<Result<PreviewRoute, PreviewError>> {
  const result = await resolvePreview(task, deps, request);
  if (
    deps.control.noteCondition(`preview-admission:${request.orbId}:${request.port}`, result.isErr())
  ) {
    logOrbEvent(
      task,
      request.orbId,
      result.isErr() ? "preview-admission-denied" : "preview-admission-recovered",
      { port: request.port, reason: result.isErr() ? result.error.code : undefined },
    );
  }
  return result;
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
): Promise<Result<PreviewRoute, PreviewError>> {
  if (request.port === 8080)
    return err(previewError("reserved_port", "The runtime port cannot be exposed"));
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)
    return err(previewError("invalid_request", "Invalid preview port"));
  if (task.wallNow() >= request.expiresAt)
    return err(previewError("unauthenticated", "Preview session expired"));
  await task.checkpoint("preview.authority-read");
  const authority = await deps.store.readPreviewAuthority(task, request);
  if (authority.isErr())
    return err(previewError("store_unavailable", "Preview authority unavailable"));
  if (authority.value === null) return err(previewError("orb_not_found", "Orb doesn't exist"));
  const { orb, registration } = authority.value;
  if (
    orb.state !== "running" ||
    orb.hostDiscardThroughIncarnation !== null ||
    orb.hostRef === null ||
    orb.runtimeTokenHash === null ||
    deps.control.isStopping(orb.id, orb.stateVersion)
  )
    return err(previewError("orb_unavailable", `Orb is ${orb.state}`));
  if (registration === null)
    return err(previewError("port_not_registered", "Preview port isn't registered"));
  if (deps.hostProvider.kind === "process")
    return err(previewError("unsupported_provider", "Previews require isolated compute"));
  const hostRef = orb.hostRef;
  const observed = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview host observation",
    (context) =>
      deps.hostProvider.observe(
        task,
        { provider: deps.hostProvider.kind, resourceId: hostRef },
        context,
      ),
  );
  if (
    observed.isErr() ||
    observed.value === null ||
    observed.value.state !== "running" ||
    observed.value.orbId !== orb.id ||
    observed.value.incarnation !== orb.hostIncarnation ||
    observed.value.runtimeAddress === undefined
  )
    return err(previewError("stale_target", "Preview compute is unavailable or replaced"));
  const baseUrl = observed.value.runtimeAddress.baseUrl;
  const health = await withDeadline(
    task,
    PREVIEW_VALIDATION_TIMEOUT_MS,
    "preview runtime identity",
    (context) => deps.runtimeClient.health(task, baseUrl, context),
  );
  if (
    health.isErr() ||
    health.value.status !== "ready" ||
    health.value.orbId !== orb.id ||
    health.value.incarnation !== orb.hostIncarnation ||
    !health.value.executionId
  )
    return err(previewError("stale_target", "Preview runtime identity unavailable"));
  const route: PreviewRoute = {
    target: {
      orbId: orb.id,
      port: request.port,
      registrationId: registration.registrationId,
      incarnation: orb.hostIncarnation,
      executionId: health.value.executionId,
      runtimeInstanceId: health.value.runtimeInstanceId,
    },
    baseUrl,
    runtimeTokenHash: orb.runtimeTokenHash,
    origin: request.origin,
    expiresAt: Math.min(request.expiresAt, task.wallNow() + PREVIEW_MAX_DURATION_MS),
  };
  await task.checkpoint("preview.before-protection");
  const protectedActivity = await protect(task, deps, route);
  if (protectedActivity.isErr()) return err(protectedActivity.error);
  await task.checkpoint("preview.transport-admission");
  if (deps.control.isStopping(orb.id, orb.stateVersion))
    return err(previewError("orb_unavailable", "Orb admission closed"));
  if (task.wallNow() >= route.expiresAt)
    return err(previewError("unauthenticated", "Preview session expired"));
  return ok(route);
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
