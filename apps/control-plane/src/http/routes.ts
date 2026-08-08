import {
  type ControlPlaneHttpError,
  CreateOrbRequestSchema,
  CreateProjectRequestSchema,
  UpdateOrbRequestSchema,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import {
  type CommandError,
  createOrb,
  requestOrbDeletion,
  requestOrbStart,
  requestOrbStop,
} from "../domain/lifecycle.ts";
import type { ProjectRow } from "../domain/orb.ts";
import { normalizeOrbName, setOrbName } from "../domain/orb-naming.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { orbView, projectView, type ViewConfig } from "./views.ts";

function httpError(
  code: ControlPlaneHttpError["error"]["code"],
  message: string,
  retryable: boolean,
): ControlPlaneHttpError {
  return { error: { code, message, retryable } };
}

function sendCommandError(reply: FastifyReply, error: CommandError): FastifyReply {
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 503;
  const code =
    error.code === "not_found"
      ? "not_found"
      : error.code === "conflict"
        ? "conflict"
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
      return reply.status(503).send(httpError("unavailable", projects.error.message, true));
    }
    return reply.send({ items: projects.value.map(projectView) });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const body = request.body;
    if (!Check(CreateProjectRequestSchema, body)) {
      return reply.status(400).send(httpError("invalid_request", "invalid project body", false));
    }
    const url = validateRepositoryUrl(body.repositoryUrl);
    if (url.isErr()) {
      return reply
        .status(400)
        .send(httpError("invalid_request", `${url.error.code}: ${url.error.message}`, false));
    }
    const existing = await deps.store.getProject(task, body.id);
    if (existing.isErr()) {
      return reply.status(503).send(httpError("unavailable", existing.error.message, true));
    }
    if (existing.value !== null) {
      // Client-generated IDs make retried creates idempotent (docs/control-plane-api.md).
      if (existing.value.name === body.name && existing.value.repositoryUrl === url.value.url) {
        return reply.status(201).send(projectView(existing.value));
      }
      return reply
        .status(409)
        .send(httpError("conflict", "project id exists with different content", false));
    }
    const row: ProjectRow = {
      id: body.id,
      name: body.name,
      repositoryUrl: url.value.url,
      createdAt: task.wallNow(),
    };
    const inserted = await deps.store.insertProject(task, row);
    if (inserted.isErr()) {
      return reply.status(503).send(httpError("unavailable", inserted.error.message, true));
    }
    return reply.status(201).send(projectView(inserted.value));
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const project = await deps.store.getProject(task, request.params.projectId);
      if (project.isErr()) {
        return reply.status(503).send(httpError("unavailable", project.error.message, true));
      }
      if (project.value === null) {
        return reply.status(404).send(httpError("not_found", "project not found", false));
      }
      return reply.send(projectView(project.value));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/orbs",
    async (request, reply) => {
      const orbs = await deps.store.listOrbsByProject(task, request.params.projectId);
      if (orbs.isErr()) {
        return reply.status(503).send(httpError("unavailable", orbs.error.message, true));
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
      return reply.status(503).send(httpError("unavailable", orb.error.message, true));
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
              : 503;
      const code =
        updated.error.code === "not_found"
          ? "not_found"
          : updated.error.code === "conflict"
            ? "conflict"
            : updated.error.code === "invalid_name"
              ? "invalid_request"
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

  app.delete<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId", async (request, reply) => {
    const deleted = await requestOrbDeletion(task, deps, request.params.orbId);
    if (deleted.isErr()) return sendCommandError(reply, deleted.error);
    return reply.status(202).send(orbView(deleted.value, deps.control, config));
  });

  app.get<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/history", async (request, reply) => {
    const orb = await deps.store.getOrb(task, request.params.orbId);
    if (orb.isErr()) {
      return reply.status(503).send(httpError("unavailable", orb.error.message, true));
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
      return reply.status(503).send(httpError("unavailable", snapshot.error.message, true));
    }
    return reply.send({ orbId: request.params.orbId, ...snapshot.value });
  });
}
