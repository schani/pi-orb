import { createHash, timingSafeEqual } from "node:crypto";
import {
  ID_TOKEN_PATH,
  type IdTokenErrorBody,
  IdTokenRequestSchema,
  type IdTokenResponseBody,
  ORB_INSPECTION_LIST_PATH,
  ORB_NAME_MESSAGE_MAX_BYTES,
  ORB_NAME_README_MAX_BYTES,
  ORB_NAME_TRIGGER_PATH,
  ORB_SELF_ARCHIVE_PATH,
  OrbArchiveRequestSchema,
  type OrbInspectionError,
  type OrbInspectionItem,
  type OrbNameTriggerResponse,
  OrbNameTriggerSchema,
  PROJECT_SECRETS_RUNTIME_PATH,
  RUNTIME_TOKENS_PREFIX,
  type TokenErrorBody,
  type TokenGrantBody,
  TokenNameSchema,
  TokenRequestSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import {
  getToken,
  RUNTIME_TOKEN_STATES,
  TOKEN_PROVIDERS,
  type TokenRequest,
} from "../domain/broker.ts";
import type { MintError, StoreError } from "../domain/errors.ts";
import type { CommandError } from "../domain/lifecycle.ts";
import type { OrbRow } from "../domain/orb.ts";
import { generateOrbName } from "../domain/orb-naming.ts";
import type {
  ArchiveCaller,
  BrokerDeps,
  ControlPlaneStore,
  MintDeps,
  OrbNameGenerator,
  ProjectSecretsDeps,
} from "../domain/ports.ts";
import { getProjectSecretSnapshot } from "../domain/project-secrets.ts";
import { mintIdToken } from "../domain/workload-identity.ts";

export interface RuntimeRouteDeps {
  readonly archiveSelf: (
    task: SimulationTask,
    orbId: string,
    caller: ArchiveCaller,
  ) => ResultAsync<OrbRow, CommandError>;
  readonly store: ControlPlaneStore;
  readonly broker: BrokerDeps;
  readonly nameGenerator: OrbNameGenerator;
  readonly nameLeaseMs: number;
  /** Identity issuance (docs/workload-identity.md); its own store lookup. */
  readonly mint: MintDeps;
  readonly projectSecrets: ProjectSecretsDeps;
}

const unauthorized: TokenErrorBody = { error: "unauthorized" };

const inspectionError = (
  code: OrbInspectionError["error"]["code"],
  message: string,
  retryable: boolean,
): OrbInspectionError => ({ v: 1, error: { code, message, retryable } });

const inspectionItem = (
  orb: OrbRow,
  project: { id: string; name: string; repositoryUrl: string },
): OrbInspectionItem => ({
  id: orb.id,
  name: orb.name,
  state: orb.state,
  updatedAt: new Date(orb.updatedAt).toISOString(),
  project,
});

function sendInspectionStoreError(reply: FastifyReply, error: StoreError): FastifyReply {
  const internal = error.code === "invariant" || error.code === "corruption";
  return reply
    .status(internal ? 500 : 503)
    .send(
      inspectionError(
        internal ? "internal" : "unavailable",
        internal ? "orb inspection failed" : "orb inspection unavailable",
        !internal,
      ),
    );
}

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
 * SHA-256 hex of the presented bearer, or null when no bearer was presented at
 * all. Hashing lives at this boundary: nothing below it ever sees the token.
 */
function bearerHash(authorization: unknown): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  return createHash("sha256").update(authorization.slice("Bearer ".length)).digest("hex");
}

/**
 * The outcome of resolving a runtime bearer. A store outage is kept apart from
 * a refusal on purpose: answering 401 for a database blip tells the runtime its
 * incarnation is dead, which is both false and unrecoverable from its side.
 */
type BearerAuth =
  | { readonly kind: "orb"; readonly orb: OrbRow }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly message: string };

const UNAUTHENTICATED: BearerAuth = { kind: "unauthorized" };

interface IdTokenFailure {
  readonly status: number;
  readonly body: IdTokenErrorBody;
  /** Set exactly when a delay is meaningful; becomes the `retry-after` header. */
  readonly retryAfterMs?: number;
}

/**
 * One mint denial as an HTTP answer. The error codes are the protocol's own,
 * so the only decision here is the status: 403 rather than 401 for a valid
 * bearer whose orb may not mint (retrying the same request is pointless until
 * the lifecycle changes), 429 for the per-orb floor, 503 for anything
 * transient, and 500 for a deterministic bug of ours, which must never be
 * advertised as retryable
 * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 */
function idTokenFailure(error: MintError): IdTokenFailure {
  switch (error.type) {
    case "invalid_request":
      return { status: 400, body: { error: "invalid_request", message: error.message } };
    case "unauthorized":
      // Deliberately detail-free: unknown, stale, and fenced bearers must be
      // indistinguishable, so the answer never reveals that another orb exists.
      return { status: 401, body: { error: "unauthorized" } };
    case "not_mintable":
      return {
        status: 403,
        body: { error: "not_mintable", message: `orb state ${error.state} may not mint` },
      };
    case "rate_limited":
      return {
        status: 429,
        body: { error: "rate_limited", retryAfterMs: error.retryAfterMs },
        retryAfterMs: error.retryAfterMs,
      };
    case "retryable":
      return {
        status: 503,
        body: {
          error: "retryable",
          message: error.message,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        },
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    case "internal":
      return { status: 500, body: { error: "internal", message: error.message } };
  }
}

/**
 * The runtime-facing surface (`docs/credentials.md`, `docs/control-plane-api.md`).
 * It contains the parameterized credential broker, workload identity, naming,
 * read-only sibling inspection, and self-archival. Registered only when the deployment role
 * includes runtime routes — a hard allowlist, not a hidden path.
 * Authentication is the per-host-incarnation orb token, honored only while
 * the calling orb's lifecycle state says its host should be up.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: RuntimeRouteDeps,
): void {
  /**
   * The one bearer check every runtime route shares: hash the presented token,
   * resolve the orb it names, and accept it only when all five conditions hold
   * — the row exists, it still carries a bearer hash, no discard fence covers
   * its incarnation, the hashes match in constant time, and the lifecycle state
   * still authorizes runtime credentials. A store failure is reported as such
   * so each route can answer it honestly.
   */
  const authenticate = async (authorization: unknown): Promise<BearerAuth> => {
    const tokenHash = bearerHash(authorization);
    if (tokenHash === null) return UNAUTHENTICATED;
    const orbResult = await deps.store.getOrbByRuntimeTokenHash(task, tokenHash);
    if (orbResult.isErr()) return { kind: "unavailable", message: "store unavailable" };
    const orb = orbResult.value;
    if (
      orb === null ||
      orb.runtimeTokenHash === null ||
      orb.hostDiscardThroughIncarnation !== null ||
      !hashesEqual(orb.runtimeTokenHash, tokenHash) ||
      !RUNTIME_TOKEN_STATES.includes(orb.state)
    ) {
      return UNAUTHENTICATED;
    }
    return { kind: "orb", orb };
  };

  app.post(ORB_SELF_ARCHIVE_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = await authenticate(request.headers.authorization);
    if (auth.kind !== "orb") {
      const unavailable = auth.kind === "unavailable";
      return reply.status(unavailable ? 503 : 401).send({
        error: {
          code: unavailable ? "unavailable" : "unauthorized",
          message: unavailable ? "archival unavailable" : "runtime identity rejected",
          retryable: unavailable,
        },
      });
    }
    if (!Check(OrbArchiveRequestSchema, request.body === undefined ? {} : request.body)) {
      return reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "self-archive accepts no fields",
          retryable: false,
        },
      });
    }
    const result = await deps.archiveSelf(task, auth.orb.id, {
      runtimeTokenHash: auth.orb.runtimeTokenHash as string,
      hostIncarnation: auth.orb.hostIncarnation,
    });
    if (result.isErr()) {
      const status = { not_found: 404, conflict: 409, unavailable: 503, internal: 500 }[
        result.error.code
      ];
      return reply.status(status).send({
        error: {
          code: result.error.code,
          message:
            result.error.code === "internal"
              ? "archival failed"
              : result.error.code === "unavailable"
                ? "archival unavailable; acceptance may be unknown"
                : result.error.message,
          retryable: result.error.retryable,
        },
      });
    }
    return reply.status(202).send({ orbId: result.value.id, state: "archiving" });
  });

  app.get(PROJECT_SECRETS_RUNTIME_PATH, async (request, reply) => {
    const auth = await authenticate(request.headers.authorization);
    if (auth.kind === "unavailable") {
      return reply.status(503).send({
        error: { code: "unavailable", message: "project secrets unavailable", retryable: true },
      });
    }
    if (auth.kind !== "orb") return sendUnauthorized(reply);
    const snapshot = await getProjectSecretSnapshot(task, deps.projectSecrets, auth.orb.projectId);
    if (snapshot.isErr()) {
      const internal = snapshot.error.type === "project_secret_corruption";
      const conflict = snapshot.error.type === "project_secret_conflict";
      return reply.status(internal ? 500 : conflict ? 409 : 503).send({
        error: {
          code: internal ? "internal" : conflict ? "conflict" : "unavailable",
          message: internal ? "project secrets are inconsistent" : "project secrets unavailable",
          retryable: !internal && !conflict,
        },
      });
    }
    reply.header("cache-control", "no-store");
    return reply.send(snapshot.value);
  });

  app.get(ORB_INSPECTION_LIST_PATH, async (request, reply) => {
    const auth = await authenticate(request.headers.authorization);
    if (auth.kind === "unavailable") {
      return reply
        .status(503)
        .send(inspectionError("unavailable", "orb inspection unavailable", true));
    }
    if (auth.kind !== "orb") return sendUnauthorized(reply);

    const projects = await deps.store.listProjects(task);
    if (projects.isErr()) return sendInspectionStoreError(reply, projects.error);
    const items: OrbInspectionItem[] = [];
    for (const project of projects.value) {
      const orbs = await deps.store.listOrbsByProject(task, project.id);
      if (orbs.isErr()) return sendInspectionStoreError(reply, orbs.error);
      const projectIdentity = {
        id: project.id,
        name: project.name,
        repositoryUrl: project.repositoryUrl,
      };
      for (const orb of orbs.value) items.push(inspectionItem(orb, projectIdentity));
    }
    items.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
    reply.header("cache-control", "no-store");
    return reply.send({ v: 1, currentOrbId: auth.orb.id, items });
  });

  app.get<{ Params: { orbId: string } }>(
    `${ORB_INSPECTION_LIST_PATH}/:orbId/transcript`,
    async (request, reply) => {
      const auth = await authenticate(request.headers.authorization);
      if (auth.kind === "unavailable") {
        return reply
          .status(503)
          .send(inspectionError("unavailable", "orb transcript unavailable", true));
      }
      if (auth.kind !== "orb") return sendUnauthorized(reply);

      const orb = await deps.store.getOrb(task, request.params.orbId);
      if (orb.isErr()) return sendInspectionStoreError(reply, orb.error);
      if (orb.value === null) {
        return reply.status(404).send(inspectionError("not_found", "orb not found", false));
      }
      if (orb.value.state === "deleting") {
        return reply
          .status(409)
          .send(inspectionError("conflict", "orb is being permanently deleted", false));
      }
      const project = await deps.store.getProject(task, orb.value.projectId);
      if (project.isErr()) return sendInspectionStoreError(reply, project.error);
      if (project.value === null) {
        return reply.status(500).send(inspectionError("internal", "orb project not found", false));
      }
      const snapshot = await deps.store.readHistorySnapshot(task, orb.value.id);
      if (snapshot.isErr()) return sendInspectionStoreError(reply, snapshot.error);
      reply.header("cache-control", "no-store");
      return reply.send({
        v: 1,
        orb: inspectionItem(orb.value, {
          id: project.value.id,
          name: project.value.name,
          repositoryUrl: project.value.repositoryUrl,
        }),
        ...snapshot.value,
      });
    },
  );

  app.post<{ Params: { name: string } }>(
    `${RUNTIME_TOKENS_PREFIX}/:name`,
    async (request, reply) => {
      const name = request.params.name;
      if (!Check(TokenNameSchema, name)) {
        const errorBody: TokenErrorBody = { error: "unknown_token" };
        return reply.status(404).send(errorBody);
      }

      const auth = await authenticate(request.headers.authorization);
      if (auth.kind === "unavailable") {
        const body: TokenErrorBody = { error: "retryable", message: auth.message };
        return reply.status(503).send(body);
      }
      if (auth.kind !== "orb") return sendUnauthorized(reply);

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
    // Naming folds a store outage into the same 401 it always has: it is a
    // cosmetic, fire-and-forget trigger the runtime replays on its next boot,
    // and nothing downstream distinguishes the two answers (TODO.md tracks
    // giving it the honest 503 the other two routes return).
    const auth = await authenticate(request.headers.authorization);
    if (auth.kind !== "orb") return sendUnauthorized(reply);
    const orb = auth.orb;
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

  /**
   * Identity minting (docs/workload-identity.md). Unlike the two routes above
   * this one does *not* run `authenticate` first: `mintIdToken` resolves the
   * bearer itself, because its snapshot read of the orb row is the mint's
   * linearization point against stop, replacement, archive, and delete. A
   * route-level check would be a second, earlier read whose answer the domain
   * would then have to ignore. The route's job is the hash, the request
   * schema, and the status fold.
   */
  app.post(ID_TOKEN_PATH, async (request, reply) => {
    const tokenHash = bearerHash(request.headers.authorization);
    if (tokenHash === null) {
      const body: IdTokenErrorBody = { error: "unauthorized" };
      return reply.status(401).send(body);
    }
    if (!Check(IdTokenRequestSchema, request.body)) {
      const body: IdTokenErrorBody = { error: "invalid_request", message: "invalid request body" };
      return reply.status(400).send(body);
    }

    const minted = await mintIdToken(task, deps.mint, {
      tokenHash,
      audience: request.body.audience,
      ...(request.body.ttlSeconds === undefined ? {} : { ttlSeconds: request.body.ttlSeconds }),
    });
    if (minted.isErr()) {
      const failure = idTokenFailure(minted.error);
      if (failure.retryAfterMs !== undefined) {
        reply.header("retry-after", Math.ceil(failure.retryAfterMs / 1000));
      }
      return reply.status(failure.status).send(failure.body);
    }

    // A JWT is a bearer credential: no cache, no store, no log — the response
    // body is the only place it ever appears (docs/workload-identity.md).
    const response: IdTokenResponseBody = { token: minted.value.token };
    reply.header("cache-control", "no-store");
    return reply.send(response);
  });
}
