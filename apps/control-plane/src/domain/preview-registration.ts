import type { PreviewError, PreviewRegistration } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { logOrbEvent } from "./log.ts";
import type { ArchiveCaller, ControlPlaneStore } from "./ports.ts";
import { previewError } from "./preview.ts";
import type { PreviewStore } from "./preview-ports.ts";

export interface PreviewRegistrationDeps {
  readonly store: PreviewStore & Pick<ControlPlaneStore, "getOrbByRuntimeTokenHash">;
  readonly url:
    | ((orbId: string, port: number) => Result<string, { type: "invalid_preview_target" }>)
    | null;
  readonly newId: () => string;
  readonly reservedPort: number;
}
interface Request {
  readonly orbId: string;
  readonly caller: ArchiveCaller;
}
interface PortRequest extends Request {
  readonly port: number;
}
const denied = () => previewError("unauthenticated", "Runtime identity is retired or unavailable");
const unavailable = () => previewError("store_unavailable", "Preview registration unavailable");
export async function authenticatePreviewRegistration(
  task: SimulationTask,
  deps: { readonly store: Pick<ControlPlaneStore, "getOrbByRuntimeTokenHash"> },
  runtimeTokenHash: string,
): Promise<Result<Request, PreviewError>> {
  const result = await deps.store.getOrbByRuntimeTokenHash(task, runtimeTokenHash);
  if (result.isErr()) return err(unavailable());
  if (!result.value || result.value.runtimeTokenHash !== runtimeTokenHash) return err(denied());
  return ok({
    orbId: result.value.id,
    caller: { runtimeTokenHash, hostIncarnation: result.value.hostIncarnation },
  });
}
function validPort(deps: PreviewRegistrationDeps, port: number): Result<void, PreviewError> {
  return !Number.isInteger(port) || port < 1 || port > 65535
    ? err(previewError("invalid_request", "Invalid preview port"))
    : port === deps.reservedPort
      ? err(previewError("reserved_port", "The runtime port cannot be exposed"))
      : ok(undefined);
}
export async function exposePreview(
  task: SimulationTask,
  deps: PreviewRegistrationDeps,
  request: PortRequest,
): Promise<Result<PreviewRegistration, PreviewError>> {
  const valid = validPort(deps, request.port);
  if (valid.isErr()) return err(valid.error);
  if (!deps.url) return err(previewError("preview_disabled", "HTTP previews are not configured"));
  const url = deps.url(request.orbId, request.port);
  if (url.isErr()) return err(previewError("invalid_request", "Invalid preview target"));
  const result = await deps.store.registerPreview(task, {
    ...request,
    registrationId: deps.newId(),
    now: task.wallNow(),
  });
  if (result.isErr()) {
    logOrbEvent(task, request.orbId, "preview-registration-failed", {
      port: request.port,
      reason: result.error.code,
    });
    return err(unavailable());
  }
  if (result.value.type === "denied") return err(denied());
  if (result.value.created)
    logOrbEvent(task, request.orbId, "preview-registered", {
      port: request.port,
      registrationId: result.value.registration.registrationId,
    });
  return ok({
    port: request.port,
    registrationId: result.value.registration.registrationId,
    url: url.value,
  });
}
export async function unexposePreview(
  task: SimulationTask,
  deps: PreviewRegistrationDeps,
  request: PortRequest,
): Promise<Result<void, PreviewError>> {
  const valid = validPort(deps, request.port);
  if (valid.isErr()) return err(valid.error);
  const result = await deps.store.unregisterPreview(task, { ...request, now: task.wallNow() });
  if (result.isErr()) {
    logOrbEvent(task, request.orbId, "preview-revocation-failed", {
      port: request.port,
      reason: result.error.code,
    });
    return err(unavailable());
  }
  if (result.value.type === "denied") return err(denied());
  if (result.value.removed)
    logOrbEvent(task, request.orbId, "preview-revoked", { port: request.port });
  return ok(undefined);
}
export async function listRegisteredPreviews(
  task: SimulationTask,
  deps: PreviewRegistrationDeps,
  request: Request,
): Promise<Result<readonly PreviewRegistration[], PreviewError>> {
  if (!deps.url) return err(previewError("preview_disabled", "HTTP previews are not configured"));
  const result = await deps.store.listPreviews(task, request);
  if (result.isErr()) return err(unavailable());
  if (result.value === null) return err(denied());
  const registrations: PreviewRegistration[] = [];
  for (const row of result.value) {
    const url = deps.url(request.orbId, row.port);
    if (url.isErr()) return err(previewError("invalid_request", "Invalid preview target"));
    registrations.push({ port: row.port, registrationId: row.registrationId, url: url.value });
  }
  return ok(registrations);
}
