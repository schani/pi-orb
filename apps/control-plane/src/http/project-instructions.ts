import { PROJECT_INSTRUCTIONS_PATH } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type ProjectInstructionsError,
  type ProjectInstructionsStore,
  readProjectInstructions,
  saveProjectInstructions,
} from "../domain/project-instructions.ts";

export function sendProjectInstructionsError(reply: FastifyReply, error: ProjectInstructionsError) {
  const status = { invalid: 400, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }[
    error.code
  ];
  return reply.status(status).send({
    error: {
      code: error.code === "invalid" ? "invalid_request" : error.code,
      message: error.message,
      retryable: error.code === "unavailable",
    },
  });
}
export function registerProjectInstructionsRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  store: ProjectInstructionsStore,
) {
  app.get<{ Params: { projectId: string } }>(PROJECT_INSTRUCTIONS_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await readProjectInstructions(task, store, request.params.projectId);
    return result.isErr()
      ? sendProjectInstructionsError(reply, result.error)
      : reply.send(result.value);
  });
  app.put<{ Params: { projectId: string } }>(PROJECT_INSTRUCTIONS_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await saveProjectInstructions(
      task,
      store,
      request.params.projectId,
      request.body,
    );
    return result.isErr()
      ? sendProjectInstructionsError(reply, result.error)
      : reply.send(result.value);
  });
}
