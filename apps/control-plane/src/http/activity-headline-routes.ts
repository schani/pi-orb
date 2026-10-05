import type { SimulationTask } from "determined";
import type { FastifyInstance } from "fastify";
import { generateActivityHeadline } from "../domain/activity-headlines.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";

export function registerActivityHeadlineRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: ControlPlaneDeps,
): void {
  app.post<{
    Params: { orbId: string; recordId: string; detailKey: string };
    Querystring: { sessionId?: string };
  }>("/api/v1/orbs/:orbId/headlines/:recordId/:detailKey", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!request.query.sessionId || request.body !== undefined)
      return reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "sessionId required; body not accepted",
          retryable: false,
        },
      });
    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    // IncomingMessage.close also fires on normal body completion. Only premature
    // response closure (or an aborted request) cancels this request's work.
    reply.raw.on("close", disconnect);
    request.raw.on("aborted", disconnect);
    const result = await generateActivityHeadline(
      task,
      deps,
      { ...request.params, sessionId: request.query.sessionId },
      { signal: controller.signal },
      request.id,
    );
    reply.raw.off("close", disconnect);
    request.raw.off("aborted", disconnect);
    if (result.isOk()) return reply.send({ headline: result.value.headline });
    const status =
      result.error.type === "invalid_session"
        ? 409
        : result.error.type === "orb_missing" || result.error.type === "detail_missing"
          ? 404
          : result.error.type === "ineligible"
            ? 400
            : 503;
    return reply.status(status).send({
      error: {
        code:
          status === 409
            ? "conflict"
            : status === 404
              ? "not_found"
              : status === 400
                ? "invalid_request"
                : "unavailable",
        message:
          status === 409
            ? "session changed"
            : status === 404
              ? "orb or detail not found"
              : status === 400
                ? "detail is ineligible"
                : "headline unavailable",
        retryable: status === 503,
      },
    });
  });
}
