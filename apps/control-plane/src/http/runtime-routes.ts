import { createHash, timingSafeEqual } from "node:crypto";
import {
  MODEL_TOKEN_PATH,
  type ModelTokenErrorBody,
  ModelTokenRequestSchema,
  type ModelTokenResponseBody,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import {
  CODEX_PROVIDER,
  getModelToken,
  type ModelTokenRequest,
  RUNTIME_TOKEN_STATES,
} from "../domain/broker.ts";
import type { BrokerDeps, ControlPlaneStore } from "../domain/ports.ts";

export interface RuntimeRouteDeps {
  readonly store: ControlPlaneStore;
  readonly broker: BrokerDeps;
}

const unauthorized: ModelTokenErrorBody = { error: "unauthorized" };

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply.status(401).send(unauthorized);
}

/** Constant-time equality over the hex digests (equal length by construction). */
function hashesEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * The runtime-facing broker surface (DESIGN.md §15.1). Registered only when
 * the deployment role includes runtime routes — a hard allowlist, not a
 * hidden path. Authentication is the per-host-incarnation orb token, honored
 * only while the orb's lifecycle state says the host should be up.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: RuntimeRouteDeps,
): void {
  app.post(MODEL_TOKEN_PATH, async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return sendUnauthorized(reply);
    }
    const tokenHash = createHash("sha256").update(header.slice("Bearer ".length)).digest("hex");

    const orbResult = await deps.store.getOrbByRuntimeTokenHash(task, tokenHash);
    if (orbResult.isErr()) {
      const body: ModelTokenErrorBody = { error: "retryable", message: "store unavailable" };
      return reply.status(503).send(body);
    }
    const orb = orbResult.value;
    if (
      orb === null ||
      orb.runtimeTokenHash === null ||
      !hashesEqual(orb.runtimeTokenHash, tokenHash) ||
      !RUNTIME_TOKEN_STATES.includes(orb.state)
    ) {
      return sendUnauthorized(reply);
    }

    const body = request.body;
    if (!Check(ModelTokenRequestSchema, body)) {
      return reply.status(400).send({ error: "retryable", message: "invalid request body" });
    }
    const tokenRequest: ModelTokenRequest = {
      reason: body.reason,
      ...(body.staleGeneration !== undefined ? { staleGeneration: body.staleGeneration } : {}),
    };

    const grant = await getModelToken(task, deps.broker, CODEX_PROVIDER, tokenRequest);
    if (grant.isErr()) {
      if (grant.error.type === "auth_required") {
        const errorBody: ModelTokenErrorBody = { error: "auth_required" };
        return reply.status(409).send(errorBody);
      }
      const errorBody: ModelTokenErrorBody = {
        error: "retryable",
        message: grant.error.message,
        ...(grant.error.retryAfterMs !== undefined
          ? { retryAfterMs: grant.error.retryAfterMs }
          : {}),
      };
      if (grant.error.retryAfterMs !== undefined) {
        reply.header("retry-after", Math.ceil(grant.error.retryAfterMs / 1000));
      }
      return reply.status(503).send(errorBody);
    }

    const response: ModelTokenResponseBody = {
      accessToken: grant.value.accessToken,
      accountId: grant.value.accountId,
      expiresAt: grant.value.expiresAt,
      generation: grant.value.generation,
    };
    reply.header("cache-control", "no-store");
    return reply.send(response);
  });
}
