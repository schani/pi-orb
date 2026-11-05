import type { Readable } from "node:stream";
import type { SimulationTask } from "determined";
import { err, type Result, type ResultAsync } from "neverthrow";
import { logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps } from "./ports.ts";

export interface FileError {
  readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 503;
  readonly message: string;
}
type FileRoute = Readonly<{ baseUrl: string; token: string; incarnation: number }>;
export type FileResponse = Readonly<{ contentType: string; length: number; body: Readable | null }>;
export interface OrbFilesTransport {
  open(
    route: FileRoute,
    request: { method: "GET" | "HEAD"; path: string },
    signal: AbortSignal,
  ): ResultAsync<FileResponse, FileError>;
}
export function recordFileOutcome(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  error: FileError | null,
): void {
  if (deps.control.noteCondition(`files:${orbId}`, error !== null))
    logOrbEvent(task, orbId, error ? "files-failed" : "files-recovered", { status: error?.status });
}
export async function readOrbFile(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  transport: OrbFilesTransport,
  request: { orbId: string; ownerUserId: string; method: "GET" | "HEAD"; path: string },
  signal: AbortSignal,
): Promise<Result<FileResponse, FileError>> {
  const unavailable = () =>
    err<FileResponse, FileError>({ status: 503, message: "Orb files unavailable" });
  if (signal.aborted) return unavailable();
  const stored = await deps.store.getOrb(task, request.orbId);
  if (signal.aborted || stored.isErr()) return unavailable();
  const orb = stored.value;
  if (!orb) return err({ status: 404, message: "Orb doesn't exist" });
  const project = await deps.store.getProject(task, orb.projectId);
  if (signal.aborted || project.isErr()) return unavailable();
  if (project.value?.ownerUserId !== request.ownerUserId)
    return err({ status: 403, message: "Only the orb owner can read its files" });
  if (
    orb.state !== "running" ||
    !orb.hostRef ||
    !orb.runtimeTokenHash ||
    orb.hostDiscardThroughIncarnation !== null ||
    deps.control.isStopping(orb.id, orb.stateVersion)
  )
    return err({ status: 503, message: `Orb is ${orb.state}; files require running compute` });
  const provider = deps.hostProvider;
  if (!["docker", "gce", "process"].includes(provider.kind) || !provider.executionBinding)
    return err({ status: 503, message: "Live files require supported compute" });
  await task.checkpoint("files.binding");
  if (signal.aborted) return unavailable();
  const binding = await provider.executionBinding(
    task,
    { provider: provider.kind, resourceId: orb.hostRef },
    { signal },
  );
  if (signal.aborted) return unavailable();
  if (
    binding.isErr() ||
    !binding.value.token ||
    binding.value.incarnation !== String(orb.hostIncarnation)
  )
    return err({ status: 409, message: "Orb execution binding changed" });
  const current = await deps.store.getOrb(task, orb.id);
  if (signal.aborted || current.isErr()) return unavailable();
  if (
    current.value?.stateVersion !== orb.stateVersion ||
    current.value.state !== "running" ||
    current.value.hostIncarnation !== orb.hostIncarnation ||
    current.value.hostRef !== orb.hostRef ||
    current.value.runtimeTokenHash !== orb.runtimeTokenHash ||
    current.value.hostDiscardThroughIncarnation !== null ||
    deps.control.isStopping(orb.id, current.value.stateVersion)
  )
    return err({ status: 409, message: "Orb admission closed or replaced" });
  return transport.open({ ...binding.value, incarnation: orb.hostIncarnation }, request, signal);
}
