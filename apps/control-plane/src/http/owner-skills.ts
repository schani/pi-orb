import { OWNER_SKILLS_PATH } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResultAsync } from "neverthrow";
import {
  createOwnerSkill,
  deleteOwnerSkill,
  listOwnerSkills,
  type OwnerSkillError,
  type OwnerSkillsDeps,
  replaceOwnerSkill,
} from "../domain/owner-skills.ts";

export function sendOwnerSkillError(reply: FastifyReply, error: OwnerSkillError) {
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

/** Owner-scoped like personal instructions; `selectUser` replies itself when it returns null. */
export function registerOwnerSkillsRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  selectUser: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>,
) {
  const handle =
    <P>(
      run: (
        userId: string,
        request: FastifyRequest<{ Params: P }>,
      ) => ResultAsync<unknown, OwnerSkillError>,
    ) =>
    async (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      const user = await selectUser(request, reply);
      if (user === null) return;
      const result = await run(user.id, request);
      return result.isErr() ? sendOwnerSkillError(reply, result.error) : reply.send(result.value);
    };
  const item = `${OWNER_SKILLS_PATH}/:name`;
  app.get(
    OWNER_SKILLS_PATH,
    handle((userId) => listOwnerSkills(task, deps.store, userId)),
  );
  app.post(
    OWNER_SKILLS_PATH,
    handle((userId, request) => createOwnerSkill(task, deps, userId, request.body)),
  );
  app.put<{ Params: { name: string } }>(
    item,
    handle<{ name: string }>((userId, request) =>
      replaceOwnerSkill(task, deps, userId, request.params.name, request.body),
    ),
  );
  app.delete<{ Params: { name: string } }>(
    item,
    handle<{ name: string }>((userId, request) =>
      deleteOwnerSkill(task, deps.store, userId, request.params.name),
    ),
  );
}
