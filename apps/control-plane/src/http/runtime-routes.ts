import { createHash, timingSafeEqual } from "node:crypto";
import {
  ORB_NAME_MESSAGE_MAX_BYTES,
  ORB_NAME_README_MAX_BYTES,
  ORB_NAME_TRIGGER_PATH,
  type OrbNameTriggerResponse,
  OrbNameTriggerSchema,
  RUNTIME_TOKENS_PREFIX,
  type TokenErrorBody,
  type TokenGrantBody,
  TokenNameSchema,
  TokenRequestSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import {
  getToken,
  RUNTIME_TOKEN_STATES,
  TOKEN_PROVIDERS,
  type TokenRequest,
} from "../domain/broker.ts";
import { generateOrbName } from "../domain/orb-naming.ts";
import type { BrokerDeps, ControlPlaneStore, OrbNameGenerator } from "../domain/ports.ts";

export interface RuntimeRouteDeps {
  readonly store: ControlPlaneStore;
  readonly broker: BrokerDeps;
  readonly nameGenerator: OrbNameGenerator;
  readonly nameLeaseMs: number;
}

const unauthorized: TokenErrorBody = { error: "unauthorized" };

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
 * The runtime-facing broker surface (docs/credentials.md, docs/credentials.md). One
 * parameterized route serves every token name; the name → provider mapping
 * is internal. Registered only when the deployment role includes runtime
 * routes — a hard allowlist, not a hidden path. Authentication is the
 * per-host-incarnation orb token, honored only while the orb's lifecycle
 * state says the host should be up.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: RuntimeRouteDeps,
): void {
  const authenticate = async (authorization: unknown) => {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
    const tokenHash = createHash("sha256")
      .update(authorization.slice("Bearer ".length))
      .digest("hex");
    const orbResult = await deps.store.getOrbByRuntimeTokenHash(task, tokenHash);
    if (orbResult.isErr()) return null;
    const orb = orbResult.value;
    if (
      orb === null ||
      orb.runtimeTokenHash === null ||
      !hashesEqual(orb.runtimeTokenHash, tokenHash) ||
      !RUNTIME_TOKEN_STATES.includes(orb.state)
    )
      return null;
    return orb;
  };

  app.post<{ Params: { name: string } }>(
    `${RUNTIME_TOKENS_PREFIX}/:name`,
    async (request, reply) => {
      const name = request.params.name;
      if (!Check(TokenNameSchema, name)) {
        const errorBody: TokenErrorBody = { error: "unknown_token" };
        return reply.status(404).send(errorBody);
      }

      const header = request.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return sendUnauthorized(reply);
      }
      const tokenHash = createHash("sha256").update(header.slice("Bearer ".length)).digest("hex");

      const orbResult = await deps.store.getOrbByRuntimeTokenHash(task, tokenHash);
      if (orbResult.isErr()) {
        const body: TokenErrorBody = { error: "retryable", message: "store unavailable" };
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
      if (!Check(TokenRequestSchema, body)) {
        return reply.status(400).send({ error: "retryable", message: "invalid request body" });
      }
      const tokenRequest: TokenRequest = {
        reason: body.reason,
        ...(body.staleGeneration !== undefined ? { staleGeneration: body.staleGeneration } : {}),
      };

      const grant = await getToken(task, deps.broker, TOKEN_PROVIDERS[name], tokenRequest);
      if (grant.isErr()) {
        if (grant.error.type === "auth_required") {
          const errorBody: TokenErrorBody = { error: "auth_required" };
          return reply.status(409).send(errorBody);
        }
        const errorBody: TokenErrorBody = {
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

      const response: TokenGrantBody = {
        accessToken: grant.value.accessToken,
        ...(grant.value.accountId !== undefined ? { accountId: grant.value.accountId } : {}),
        expiresAt: grant.value.expiresAt,
        generation: grant.value.generation,
      };
      reply.header("cache-control", "no-store");
      return reply.send(response);
    },
  );

  app.post(ORB_NAME_TRIGGER_PATH, async (request, reply) => {
    const orb = await authenticate(request.headers.authorization);
    if (orb === null) return sendUnauthorized(reply);
    if (!Check(OrbNameTriggerSchema, request.body)) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    const textBytes = Buffer.byteLength(request.body.text);
    const readmeBytes =
      request.body.readme === undefined ? 0 : Buffer.byteLength(request.body.readme);
    if (textBytes > ORB_NAME_MESSAGE_MAX_BYTES || readmeBytes > ORB_NAME_README_MAX_BYTES) {
      return reply.status(413).send({ error: "invalid_request" });
    }
    const generated = await generateOrbName(
      task,
      { store: deps.store, generator: deps.nameGenerator, leaseMs: deps.nameLeaseMs },
      orb.id,
      {
        message:
          request.body.text === "" && request.body.imageOnly
            ? "[image-only request]"
            : request.body.text,
        readme: request.body.readme ?? null,
      },
    );
    if (generated.isErr()) {
      const status = generated.error.retryable
        ? 503
        : generated.error.code === "not_found"
          ? 404
          : // A deterministic store bug is ours, not a bad request.
            generated.error.code === "invariant"
            ? 500
            : 400;
      return reply
        .status(status)
        .send({ error: generated.error.code, message: generated.error.message });
    }
    const response: OrbNameTriggerResponse = { outcome: generated.value };
    return reply.send(response);
  });
}
