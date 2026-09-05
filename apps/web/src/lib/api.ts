import {
  ControlPlaneHttpErrorSchema,
  type CreateOrbRequest,
  type CreateProjectRequest,
  type EnqueueOrbMessageRequest,
  ListResponseSchema,
  type OrbHistoryView,
  OrbHistoryViewSchema,
  OrbMessageListViewSchema,
  type OrbMessageView,
  OrbMessageViewSchema,
  type OrbView,
  OrbViewSchema,
  type ProjectSecretList,
  ProjectSecretListSchema,
  type ProjectView,
  ProjectViewSchema,
  projectSecretPath,
  projectSecretsPath,
  SessionProbeSchema,
  type SystemView,
  SystemViewSchema,
  type UpdateOrbRequest,
  type UpdateProjectRequest,
} from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  beginSessionRequest,
  reportApplicationReached,
  reportAuthenticationRequired,
} from "./session.ts";

/** Typed failure of a control-plane HTTP call. */
export type ApiError =
  | { type: "auth_required"; message: string }
  | { type: "network"; message: string }
  | {
      type: "http";
      status: number;
      /** Control-plane error code when the body matched the error shape. */
      code: string | null;
      message: string;
      retryable: boolean;
    }
  | { type: "invalid_response"; message: string };

export function describeApiError(error: ApiError): string {
  switch (error.type) {
    case "auth_required":
      return error.message;
    case "network":
      return `network error: ${error.message}`;
    case "http":
      return error.code === null
        ? `HTTP ${error.status}: ${error.message}`
        : `${error.code}: ${error.message}`;
    case "invalid_response":
      return error.message;
  }
}

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const jsonHeaders = { "content-type": "application/json" } as const;

/**
 * Boundary adapter around `fetch`: catches transport/parse exceptions and
 * validates both success and error bodies against their closed schemas.
 */
async function apiFetch<S extends TSchema>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<Result<Static<S>, ApiError>> {
  const sequence = beginSessionRequest();
  const headers = new Headers(init?.headers);
  // IAP returns 401 to AJAX requests instead of redirecting them to Google.
  // Without this signal, fetch can flatten the cross-origin redirect into an
  // indistinguishable network/CORS failure.
  headers.set("x-requested-with", "XMLHttpRequest");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    return err({ type: "network", message: describeThrown(cause) });
  }

  if (response.status === 401) {
    reportAuthenticationRequired(sequence);
    return err({
      type: "auth_required",
      message: "Your pi-orb session expired. Sign in again to continue.",
    });
  }
  reportApplicationReached(sequence);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    if (Check(ControlPlaneHttpErrorSchema, body)) {
      return err({
        type: "http",
        status: response.status,
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable,
      });
    }
    return err({
      type: "http",
      status: response.status,
      code: null,
      message: `request to ${path} failed`,
      retryable: response.status >= 500,
    });
  }

  if (!Check(schema, body)) {
    return err({
      type: "invalid_response",
      message: `unexpected response shape from ${path}`,
    });
  }
  return ok(body);
}

const ProjectListSchema = ListResponseSchema(ProjectViewSchema);
const OrbListSchema = ListResponseSchema(OrbViewSchema);

export function probeSession() {
  return apiFetch(SessionProbeSchema, "/api/v1/session", { cache: "no-store" });
}

export function getSystem(): Promise<Result<SystemView, ApiError>> {
  return apiFetch(SystemViewSchema, "/api/v1/system");
}

export function listProjects(): Promise<Result<{ items: ProjectView[] }, ApiError>> {
  return apiFetch(ProjectListSchema, "/api/v1/projects");
}

export function getProject(projectId: string): Promise<Result<ProjectView, ApiError>> {
  return apiFetch(ProjectViewSchema, `/api/v1/projects/${encodeURIComponent(projectId)}`);
}

export function updateProject(
  projectId: string,
  request: UpdateProjectRequest,
): Promise<Result<ProjectView, ApiError>> {
  return apiFetch(ProjectViewSchema, `/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(request),
  });
}

export function deleteProject(projectId: string): Promise<Result<ProjectView, ApiError>> {
  return apiFetch(ProjectViewSchema, `/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export function listProjectSecrets(
  projectId: string,
): Promise<Result<ProjectSecretList, ApiError>> {
  return apiFetch(ProjectSecretListSchema, projectSecretsPath(projectId), { cache: "no-store" });
}

export function putProjectSecret(
  projectId: string,
  name: string,
  value: string,
): Promise<Result<ProjectSecretList, ApiError>> {
  return apiFetch(ProjectSecretListSchema, projectSecretPath(projectId, name), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ value }),
  });
}

export function deleteProjectSecret(
  projectId: string,
  name: string,
): Promise<Result<ProjectSecretList, ApiError>> {
  return apiFetch(ProjectSecretListSchema, projectSecretPath(projectId, name), {
    method: "DELETE",
  });
}

export function createProject(
  request: CreateProjectRequest,
): Promise<Result<ProjectView, ApiError>> {
  return apiFetch(ProjectViewSchema, "/api/v1/projects", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(request),
  });
}

export function listOrbs(projectId: string): Promise<Result<{ items: OrbView[] }, ApiError>> {
  return apiFetch(OrbListSchema, `/api/v1/projects/${encodeURIComponent(projectId)}/orbs`);
}

export function createOrb(
  projectId: string,
  request: CreateOrbRequest,
): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/projects/${encodeURIComponent(projectId)}/orbs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(request),
  });
}

export function updateOrb(
  orbId: string,
  request: UpdateOrbRequest,
): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(request),
  });
}

export function archiveOrb(orbId: string): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/archive`, {
    method: "POST",
  });
}

export function deleteOrb(orbId: string): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}`, {
    method: "DELETE",
  });
}

export function getOrb(orbId: string): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}`);
}

export function startOrb(orbId: string): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/start`, {
    method: "POST",
  });
}

export function stopOrb(orbId: string): Promise<Result<OrbView, ApiError>> {
  return apiFetch(OrbViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/stop`, {
    method: "POST",
  });
}

export function enqueueOrbMessage(
  orbId: string,
  messageId: string,
  request: EnqueueOrbMessageRequest,
): Promise<Result<OrbMessageView, ApiError>> {
  return apiFetch(
    OrbMessageViewSchema,
    `/api/v1/orbs/${encodeURIComponent(orbId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PUT", headers: jsonHeaders, body: JSON.stringify(request) },
  );
}

export function listOrbMessages(orbId: string) {
  return apiFetch(OrbMessageListViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/messages`);
}

export function getOrbHistory(orbId: string): Promise<Result<OrbHistoryView, ApiError>> {
  return apiFetch(OrbHistoryViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/history`);
}
