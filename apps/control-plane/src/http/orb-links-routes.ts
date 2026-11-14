import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { StoreError } from "../domain/errors.ts";
import { logOrbEvent } from "../domain/log.ts";
import {
  type OrbLinkDeps,
  readOrbLinkSteps,
  readOrbLinks,
  removeOrbLink,
} from "../domain/orb-links.ts";

const isOrbId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const failure = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
) => reply.status(status).send({ error: { code, message, retryable } });

const notFound = (reply: FastifyReply) =>
  failure(reply, 404, "not_found", "orb does not exist", false);

const storeFailure = (reply: FastifyReply, error: StoreError) =>
  error.code === "unavailable"
    ? failure(reply, 503, "unavailable", "links unavailable", true)
    : failure(reply, 500, "internal", error.message, false);

/** Browser view and removal of an orb's GitHub links (docs/orb-links.md). */
export function registerOrbLinkRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: OrbLinkDeps,
): void {
  const failures = new Set<string>();
  const observe = (orbId: string, operation: string, error: string | null, checkId?: string) => {
    const key = JSON.stringify([orbId, operation, checkId]);
    if (error !== null) {
      if (!failures.has(key)) {
        failures.add(key);
        logOrbEvent(task, orbId, "github-links-failed", { operation, checkId, reason: error });
      }
    } else if (failures.delete(key)) {
      logOrbEvent(task, orbId, "github-links-recovered", { operation, checkId });
    }
  };

  app.get<{ Params: { orbId: string } }>("/api/v1/orbs/:orbId/links", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!isOrbId(request.params.orbId)) return notFound(reply);
    const links = await readOrbLinks(task, deps, request.params.orbId);
    if (links.isErr())
      return links.error.type === "orb_not_found"
        ? notFound(reply)
        : storeFailure(reply, links.error);
    observe(request.params.orbId, "status", links.value.githubError);
    return reply.send(links.value);
  });

  app.get<{ Params: { orbId: string }; Querystring: { checkId?: unknown } }>(
    "/api/v1/orbs/:orbId/links/steps",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { orbId } = request.params;
      if (!isOrbId(orbId)) return notFound(reply);
      const { checkId } = request.query;
      if (typeof checkId !== "string" || !/^[A-Za-z0-9_=-]{1,512}$/u.test(checkId))
        return failure(reply, 400, "invalid_request", "valid checkId is required", false);
      const steps = await readOrbLinkSteps(task, deps, orbId, checkId);
      if (steps.isErr()) {
        if (steps.error.type === "orb_not_found") return notFound(reply);
        return storeFailure(reply, steps.error);
      }
      observe(orbId, "steps", steps.value.githubError, checkId);
      return reply.send(steps.value);
    },
  );

  app.delete<{ Params: { orbId: string }; Querystring: { url?: unknown } }>(
    "/api/v1/orbs/:orbId/links",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!isOrbId(request.params.orbId)) return notFound(reply);
      const url = request.query.url;
      if (typeof url !== "string" || url === "")
        return failure(reply, 400, "invalid_request", "url is required", false);
      const removed = await removeOrbLink(task, deps.store, request.params.orbId, url);
      return removed.isErr() ? storeFailure(reply, removed.error) : reply.status(204).send();
    },
  );
}
