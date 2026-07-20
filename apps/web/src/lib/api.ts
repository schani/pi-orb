import { err, ok, type Result } from "neverthrow";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  ControlPlaneHttpErrorSchema,
  ListResponseSchema,
  OrbHistoryViewSchema,
  OrbViewSchema,
  ProjectViewSchema,
  type CreateOrbRequest,
  type CreateProjectRequest,
  type OrbHistoryView,
  type OrbView,
  type ProjectView,
} from "@pi-orb/protocol";

/** Typed failure of a control-plane HTTP call. */
export type ApiError =
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
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    return err({ type: "network", message: describeThrown(cause) });
  }

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

export function listProjects(): Promise<Result<{ items: ProjectView[] }, ApiError>> {
  return apiFetch(ProjectListSchema, "/api/v1/projects");
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

export function getOrbHistory(orbId: string): Promise<Result<OrbHistoryView, ApiError>> {
  return apiFetch(OrbHistoryViewSchema, `/api/v1/orbs/${encodeURIComponent(orbId)}/history`);
}
