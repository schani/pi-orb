import {
  type ControlPlaneHttpError,
  CreateOrbRequestSchema,
  CreateProjectRequestSchema,
  EnqueueOrbMessageRequestSchema,
  PROJECT_NAME_MAX_CHARS,
  UpdateOrbRequestSchema,
  UpdateProjectRequestSchema,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import type { StoreError } from "../domain/errors.ts";
import {
  type CommandError,
  createOrb,
  enqueueOrbMessage,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbStart,
  requestOrbStop,
} from "../domain/lifecycle.ts";
import type { OrbMessageRow, ProjectRow } from "../domain/orb.ts";
import { normalizeOrbName, setOrbName } from "../domain/orb-naming.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { type ProjectCommandError, requestProjectDeletion } from "../domain/project-deletion.ts";
import { orbView, projectView, type ViewConfig } from "./views.ts";

function httpError(
  code: ControlPlaneHttpError["error"]["code"],
  message: string,
  retryable: boolean,
): ControlPlaneHttpError {
  return { error: { code, message, retryable } };
}

function normalizeProjectName(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized !== "" && Array.from(normalized).length <= PROJECT_NAME_MAX_CHARS
    ? normalized
    : null;
}

function messageView(row: OrbMessageRow) {
  return {
    id: row.messageId,
    orbId: row.orbId,
    content: row.content,
    status: row.status,
    ...(row.delivery !== null ? { delivery: row.delivery } : {}),
    ...(row.operationId !== null ? { operationId: row.operationId } : {}),
    ...(row.lastError !== null ? { error: row.lastError } : {}),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * A store failure as an HTTP answer. A `StoreError` with code `invariant` is a
 * deterministic bug of ours — a bad parameter encoding, a column the schema
 * does not have — so it answers a non-retryable 500 instead of the 503 that
 * would tell every client to keep trying
 * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 */
function sendStoreError(reply: FastifyReply, error: StoreError): FastifyReply {
  return error.code === "invariant"
    ? reply.status(500).send(httpError("internal", error.message, false))
    : reply.status(503).send(httpError("unavailable", error.message, true));
}

function sendCommandError(
  reply: FastifyReply,
  error: CommandError | ProjectCommandError,
): FastifyReply {
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "conflict"
        ? 409
        : error.code === "internal"
          ? 500
          : 503;
  const code =
    error.code === "not_found"
      ? "not_found"
      : error.code === "conflict"
        ? "conflict"
        : error.code === "internal"
          ? "internal"
          : "unavailable";
  return reply.status(status).send(httpError(code, error.message, error.retryable));
}

/**
 * The docs/control-plane-api.md JSON API: Fastify handlers validate TypeBox schemas, call
 * Result-returning domain services, and fold each result into an explicit
 * response. No exceptions for normal control flow.
 */
export function registerRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: ControlPlaneDeps,
  config: ViewConfig,
): void {
  app.get("/api/v1/projects", async (_request, reply) => {
    const projects = await deps.store.listProjects(task);
    if (projects.isErr()) {
      return sendStoreError(reply, projects.error);
    }
    const items = [];
    for (const project of projects.value) {
      if (project.state === "active") {
        items.push(projectView(project));
        continue;
      }
      const progress = await deps.store.getProjectDeletionProgress(task, project.id);
      if (progress.isErr()) {
        // Finalization may win after listProjects returned its snapshot.
        if (progress.error.type === "project_conflict" && progress.error.reason === "not_found") {
          continue;
        }
        return progress.error.type === "store_error"
          ? sendStoreError(reply, progress.error)
          : reply
              .status(503)
              .send(httpError("unavailable", "project deletion progress unavailable", true));
      }
      items.push(projectView(project, progress.value));
    }
    return reply.send({ items });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const body = request.body;
    if (!Check(CreateProjectRequestSchema, body)) {
      return reply.status(400).send(httpError("invalid_request", "invalid project body", false));
    }
    const name = normalizeProjectName(body.name);
    if (name === null) {
      return reply
        .status(400)
        .send(
          httpError(
            "invalid_request",
            `project name must contain 1-${PROJECT_NAME_MAX_CHARS} characters`,
            false,
          ),
        );
    }
    const url = validateRepositoryUrl(body.repositoryUrl);
    if (url.isErr()) {
      return reply
        .status(400)
        .send(httpError("invalid_request", `${url.error.code}: ${url.error.message}`, false));
    }
    const existing = await deps.store.getProject(task, body.id);
    if (existing.isErr()) {
      return sendStoreError(reply, existing.error);
    }
    if (existing.value !== null) {
      if (existing.value.state === "deleting") {
        return reply
          .status(409)
          .send(httpError("conflict", "project is being permanently deleted", false));
      }
      // Client-generated IDs make retried creates idempotent (docs/control-plane-api.md).
      if (existing.value.name === name && existing.value.repositoryUrl === url.value.url) {
        return reply.status(201).send(projectView(existing.value));
      }
      return reply
        .status(409)
        .send(httpError("conflict", "project id exists with different content", false));
    }
    const row: ProjectRow = {
      id: body.id,
      name,
      repositoryUrl: url.value.url,
      state: "active",
      stateVersion: 0,
      deletionRequestedAt: null,
      deletionInitialOrbCount: null,
      createdAt: task.wallNow(),
      updatedAt: task.wallNow(),
    };
    const inserted = await deps.store.insertProject(task, row);
    if (inserted.isErr()) {
      return sendStoreError(reply, inserted.error);
    }
    return reply.status(201).send(projectView(inserted.value));
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const project = await deps.store.getProject(task, request.params.projectId);
      if (project.isErr()) {
        return sendStoreError(reply, project.error);
      }
      if (project.value === null) {
        return reply.status(404).send(httpError("not_found", "project not found", false));
      }
      if (project.value.state === "active") return reply.send(projectView(project.value));
      const progress = await deps.store.getProjectDeletionProgress(task, project.value.id);
      if (progress.isErr()) {
        if (progress.error.type === "project_conflict" && progress.error.reason === "not_found") {
          return reply.status(404).send(httpError("not_found", "project not found", false));
        }
        return progress.error.type === "store_error"
          ? sendStoreError(reply, progress.error)
          : reply
              .status(503)
              .send(httpError("unavailable", "project deletion progress unavailable", true));
      }
      return reply.send(projectView(project.value, progress.value));
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const body = request.body;
      if (!Check(UpdateProjectRequestSchema, body)) {
        return reply.status(400).send(httpError("invalid_request", "invalid project body", false));
      }
      const name = normalizeProjectName(body.name);
      if (name === null) {
        return reply
          .status(400)
          .send(
            httpError(
              "invalid_request",
              `project name must contain 1-${PROJECT_NAME_MAX_CHARS} characters`,
              false,
            ),
          );
      }
      const updated = await deps.store.setProjectName(task, {
        projectId: request.params.projectId,
        name,
        now: task.wallNow(),
      });
      if (updated.isErr()) {
        return sendStoreError(reply, updated.error);
      }
      if (updated.value !== null) return reply.send(projectView(updated.value));

      const current = await deps.store.getProject(task, request.params.projectId);
      if (current.isErr()) {
        return sendStoreError(reply, current.error);
      }
      return current.value === null
        ? reply.status(404).send(httpError("not_found", "project not found", false))
        : reply
            .status(409)
            .send(httpError("conflict", "project is being permanently deleted", false));
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const deleted = await requestProjectDeletion(task, deps, request.params.projectId);
      if (deleted.isErr()) return sendCommandError(reply, deleted.error);
      const progress = await deps.store.getProjectDeletionProgress(task, deleted.value.id);
      if (progress.isErr()) {
        // A zero-child project can finalize between the accepted command and
        // this presentation read. The command still returns its required 202.
        if (progress.error.type === "project_conflict" && progress.error.reason === "not_found") {
          return reply.status(202).send(
            projectView(deleted.value, {
              total: deleted.value.deletionInitialOrbCount ?? 0,
              remaining: 0,
              blocked: 0,
            }),
          );
        }
        return progress.error.type === "store_error"
          ? sendStoreError(reply, progress.error)
          : reply
              .status(503)
              .send(httpError("unavailable", "project deletion progress unavailable", true));
      }
      return reply.status(202).send(projectView(deleted.value, progress.value));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/orbs",
    async (request, reply) => {
      const project = await deps.store.getProject(task, request.params.projectId);
      if (project.isErr()) {
        return sendStoreError(reply, project.error);
      }
      if (project.value === null) {
        return reply.status(404).send(httpError("not_found", "project not found", false));
      }
      const orbs = await deps.store.listOrbsByProject(task, request.params.projectId);
      if (orbs.isErr()) {
        return sendStoreError(reply, orbs.error);
      }
      return reply.send({ items: orbs.value.map((orb) => orbView(orb, deps.control, config)) });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/orbs",
    async (request, reply) => {
      const body = request.body;
      if (!Check(CreateOrbRequestSchema, body)) {
        return reply.status(400).send(httpError("invalid_request", "invalid orb body", false));
      }
      const normalizedName = body.name === undefined ? null : normalizeOrbName(body.name);
      if (normalizedName?.isErr()) {
        return reply
          .status(400)
          .send(httpError("invalid_request", normalizedName.error.message, false));
      }
      const created = await createOrb(task, deps, {
        orbId: body.id,
        projectId: request.params.projectId,
        ...(normalizedName?.isOk() ? { name: normalizedName.value } : {}),
      });
      if (created.isErr()) return sendCommandError(reply, created.error);
      // Creation also requests the initial start; reconciliation picks it up.
      return reply.status(202).send(orbView(created.value, deps.control, config));
    },
  );

  app.get<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId", async (request, reply) => {
    const orb = await deps.store.getOrb(task, request.params.orbId);
    if (orb.isErr()) {
      return sendStoreError(reply, orb.error);
    }
    if (orb.value === null) {
      return reply.status(404).send(httpError("not_found", "orb not found", false));
    }
    return reply.send(orbView(orb.value, deps.control, config));
  });

  app.patch<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId", async (request, reply) => {
    if (!Check(UpdateOrbRequestSchema, request.body)) {
      return reply.status(400).send(httpError("invalid_request", "invalid orb update body", false));
    }
    const updated = await setOrbName(
      task,
      deps.store,
      request.params.orbId,
      request.body.name,
      task.wallNow(),
    );
    if (updated.isErr()) {
      const status =
        updated.error.code === "not_found"
          ? 404
          : updated.error.code === "conflict"
            ? 409
            : updated.error.code === "invalid_name"
              ? 400
              : updated.error.code === "invariant"
                ? 500
                : 503;
      const code =
        updated.error.code === "not_found"
          ? "not_found"
          : updated.error.code === "conflict"
            ? "conflict"
            : updated.error.code === "invalid_name"
              ? "invalid_request"
              : updated.error.code === "invariant"
                ? "internal"
                : "unavailable";
      return reply
        .status(status)
        .send(httpError(code, updated.error.message, updated.error.retryable));
    }
    return reply.send(orbView(updated.value, deps.control, config));
  });

  app.post<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/start", async (request, reply) => {
    const started = await requestOrbStart(task, deps, request.params.orbId);
    if (started.isErr()) return sendCommandError(reply, started.error);
    return reply.status(202).send(orbView(started.value, deps.control, config));
  });

  app.post<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/stop", async (request, reply) => {
    const stopped = await requestOrbStop(task, deps, request.params.orbId);
    if (stopped.isErr()) return sendCommandError(reply, stopped.error);
    return reply.status(202).send(orbView(stopped.value, deps.control, config));
  });

  app.post<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/archive", async (request, reply) => {
    const archived = await requestOrbArchive(task, deps, request.params.orbId);
    if (archived.isErr()) return sendCommandError(reply, archived.error);
    return reply.status(202).send(orbView(archived.value, deps.control, config));
  });

  app.delete<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId", async (request, reply) => {
    const deleted = await requestOrbDeletion(task, deps, request.params.orbId);
    if (deleted.isErr()) return sendCommandError(reply, deleted.error);
    return reply.status(202).send(orbView(deleted.value, deps.control, config));
  });

  app.put<{ Params: { orbId: string; messageId: string } }>(
    "/api/v1/orbs/:orbId/messages/:messageId",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      if (!Check(EnqueueOrbMessageRequestSchema, request.body)) {
        return reply.status(400).send(httpError("invalid_request", "invalid message body", false));
      }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          request.params.messageId,
        )
      ) {
        return reply
          .status(400)
          .send(httpError("invalid_request", "message id must be a UUID", false));
      }
      if (JSON.stringify(request.body.content).length > 6 * 1024 * 1024) {
        return reply.status(400).send(httpError("invalid_request", "message is too large", false));
      }
      // Admission and the reconciler nudge live in the domain command; the
      // lifecycle transition a queued message may cause belongs to the
      // reconciler, not to this caller (docs/lifecycle.md).
      const enqueued = await enqueueOrbMessage(task, deps, {
        orbId: request.params.orbId,
        messageId: request.params.messageId,
        content: request.body.content,
      });
      if (enqueued.isErr()) return sendCommandError(reply, enqueued.error);
      return reply.status(202).send(messageView(enqueued.value.message));
    },
  );

  app.get<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/messages", async (request, reply) => {
    const orb = await deps.store.getOrb(task, request.params.orbId);
    if (orb.isErr()) return sendStoreError(reply, orb.error);
    if (orb.value === null)
      return reply.status(404).send(httpError("not_found", "orb not found", false));
    const messages = await deps.store.listOrbMessages(task, request.params.orbId);
    return messages.isErr()
      ? sendStoreError(reply, messages.error)
      : reply.send({ items: messages.value.map(messageView) });
  });

  app.get<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/history", async (request, reply) => {
    const orb = await deps.store.getOrb(task, request.params.orbId);
    if (orb.isErr()) {
      return sendStoreError(reply, orb.error);
    }
    if (orb.value === null) {
      return reply.status(404).send(httpError("not_found", "orb not found", false));
    }
    if (orb.value.state === "deleting") {
      return reply
        .status(409)
        .send(httpError("conflict", "orb is being permanently deleted", false));
    }
    const snapshot = await deps.store.readHistorySnapshot(task, request.params.orbId);
    if (snapshot.isErr()) {
      return sendStoreError(reply, snapshot.error);
    }
    return reply.send({ orbId: request.params.orbId, ...snapshot.value });
  });
}
