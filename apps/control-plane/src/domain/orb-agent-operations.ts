import { createHash } from "node:crypto";
import { previewHost } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { acceptsCentralAgentCaller } from "./agent-authorization.ts";
import { requestOrbArchive, requestOrbDeletion, requestOrbSleep } from "./lifecycle.ts";
import type { OrbRow } from "./orb.ts";
import { normalizeOrbName } from "./orb-naming.ts";
import { spawnOrb } from "./orb-spawning.ts";
import type { CentralAgentCaller, ControlPlaneDeps } from "./ports.ts";

export interface OrbAgentIdentity {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly orbId: string;
  readonly incarnation: number;
  readonly runtimeTokenHash: string;
}
export type OrbAgentRequest =
  | { kind: "self" | "list" | "archive" | "delete" }
  | { kind: "transcript"; orbId: string }
  | { kind: "spawn"; prompt: string; name?: string }
  | { kind: "alert"; message: string }
  | { kind: "sleep"; durationSeconds: number };
export interface OrbAgentError {
  readonly code:
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "unavailable"
    | "internal"
    | "invalid_request";
  readonly message: string;
}
export interface OrbAgentOperations {
  invoke(request: OrbAgentRequest, requestId: string): ResultAsync<unknown, OrbAgentError>;
}
export interface OrbAgentOptions {
  readonly appOrigin: string;
  readonly tailnetDnsName?: string;
  /** Must append a durable transcript alert and update its unread projection atomically/idempotently. */
  readonly appendAlert: (
    orbId: string,
    requestId: string,
    message: string,
    expectedAdmissionVersion: number,
  ) => ResultAsync<{ recordId: string }, OrbAgentError>;
}
const failure = (code: OrbAgentError["code"], message: string): OrbAgentError => ({
  code,
  message,
});
/** Stable UUID scoped to the calling orb and durable tool task, never supplied by model arguments. */
export function orbToolRequestId(orbId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([orbId, requestId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function createOrbAgentOperations(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  boundIdentity: OrbAgentIdentity | CentralAgentCaller,
  options: OrbAgentOptions,
): OrbAgentOperations {
  const identity = { ...boundIdentity };
  const url = (id: string) => `${options.appOrigin}/orbs/${id}`;
  const central = "kind" in identity && identity.kind === "central" ? identity : null;
  const caller = central ?? {
    runtimeTokenHash: (identity as OrbAgentIdentity).runtimeTokenHash,
    hostIncarnation: (identity as OrbAgentIdentity).incarnation,
  };
  const unavailable = () => failure("unavailable", "orb operation unavailable");
  const item = (orb: OrbRow, project: { id: string; name: string; repositoryUrl: string }) => ({
    id: orb.id,
    name: orb.name,
    state: orb.state,
    updatedAt: new Date(orb.updatedAt).toISOString(),
    project: { id: project.id, name: project.name, repositoryUrl: project.repositoryUrl },
  });
  return {
    invoke(request, requestId) {
      return new ResultAsync(
        (async () => {
          const current = await deps.store.getOrb(task, identity.orbId);
          if (current.isErr()) return err(unavailable());
          const orb = current.value;
          if (
            !orb ||
            orb.projectId !== identity.projectId ||
            (central === null &&
              (orb.hostIncarnation !== (identity as OrbAgentIdentity).incarnation ||
                orb.runtimeTokenHash !== identity.runtimeTokenHash ||
                orb.hostDiscardThroughIncarnation !== null))
          )
            return err(failure("unauthorized", "agent identity rejected"));
          const project = await deps.store.getProject(task, identity.projectId);
          if (project.isErr()) return err(unavailable());
          if (!project.value || project.value.ownerUserId !== identity.ownerUserId)
            return err(failure("unauthorized", "agent identity rejected"));
          if (
            central !== null &&
            !acceptsCentralAgentCaller(orb, project.value.ownerUserId, central)
          )
            return err(failure("unauthorized", "agent identity rejected"));
          if (!requestId) return err(failure("invalid_request", "request ID required"));
          switch (request.kind) {
            case "self": {
              const spawnedBy = await deps.store.getSpawnCaller(task, orb.id);
              if (spawnedBy.isErr()) return err(unavailable());
              return ok({
                orb: {
                  id: orb.id,
                  name: orb.name,
                  url: url(orb.id),
                  createdAt: new Date(orb.createdAt).toISOString(),
                },
                project: item(orb, project.value).project,
                spawnedBy:
                  spawnedBy.value === null
                    ? null
                    : { id: spawnedBy.value, url: url(spawnedBy.value) },
                previewHost:
                  options.tailnetDnsName === undefined
                    ? null
                    : previewHost(orb.id, options.tailnetDnsName),
              });
            }
            case "list": {
              const projects = await deps.store.listProjectsByOwner(task, identity.ownerUserId);
              if (projects.isErr()) return err(unavailable());
              const items = [];
              for (const p of projects.value) {
                const rows = await deps.store.listOrbsByProject(task, p.id);
                if (rows.isErr()) return err(unavailable());
                for (const row of rows.value) items.push(item(row, p));
              }
              items.sort(
                (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
              );
              return ok({ currentOrbId: orb.id, items });
            }
            case "transcript": {
              // Explicit company-wide inspection matches the runtime CLI policy; discovery is owner-scoped.
              const target = await deps.store.getOrb(task, request.orbId);
              if (target.isErr()) return err(unavailable());
              if (!target.value) return err(failure("not_found", "orb not found"));
              if (target.value.state === "deleting")
                return err(failure("conflict", "orb is being permanently deleted"));
              const p = await deps.store.getProject(task, target.value.projectId);
              if (p.isErr()) return err(unavailable());
              if (!p.value) return err(failure("internal", "orb project missing"));
              const history = await deps.store.readHistorySnapshot(task, target.value.id);
              if (history.isErr()) return err(unavailable());
              return ok({ orb: item(target.value, p.value), ...history.value });
            }
            case "spawn": {
              if (central === null && orb.state !== "running")
                return err(failure("conflict", "orb is not running"));
              if (!request.prompt.trim()) return err(failure("invalid_request", "prompt required"));
              const name = request.name === undefined ? undefined : normalizeOrbName(request.name);
              if (name?.isErr()) return err(failure("invalid_request", name.error.message));
              const id = orbToolRequestId(orb.id, requestId);
              const result = await spawnOrb(
                task,
                deps,
                orb,
                id,
                {
                  prompt: request.prompt,
                  ...(name?.isOk() ? { name: name.value } : {}),
                },
                caller,
              );
              if (result.isErr())
                return err(
                  result.error.type === "spawn_conflict"
                    ? failure("conflict", "spawn conflicts with existing work")
                    : unavailable(),
                );
              return ok({ orbId: id, projectId: orb.projectId, messageId: id, url: url(id) });
            }
            case "alert":
              if (central === null && orb.state !== "running")
                return err(failure("conflict", "orb is not running"));
              if (!request.message.trim())
                return err(failure("invalid_request", "alert message required"));
              return await options.appendAlert(
                orb.id,
                requestId,
                request.message,
                central?.agentAdmissionVersion ?? orb.agentAdmissionVersion,
              );
            case "sleep": {
              const sleepId = orbToolRequestId(orb.id, requestId);
              if (orb.sleepId === sleepId && orb.sleepUntil !== null)
                return ok({ sleepId, sleepUntil: orb.sleepUntil });
              return await requestOrbSleep(
                task,
                deps,
                orb.id,
                caller,
                request.durationSeconds,
                sleepId,
              ).mapErr((e) => failure(e.code, e.message));
            }
            case "archive":
              return await requestOrbArchive(task, deps, orb.id, caller)
                .map((row) => ({ orbId: row.id, state: row.state }))
                .mapErr((e) => failure(e.code, e.message));
            case "delete":
              return await requestOrbDeletion(task, deps, orb.id, caller)
                .map((row) => ({ orbId: row.id, state: row.state }))
                .mapErr((e) => failure(e.code, e.message));
          }
        })(),
      );
    },
  };
}

export function createCentralOrbAgentOperations(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  identity: Omit<CentralAgentCaller, "kind">,
  options: OrbAgentOptions,
): OrbAgentOperations {
  return createOrbAgentOperations(task, deps, { ...identity, kind: "central" }, options);
}
