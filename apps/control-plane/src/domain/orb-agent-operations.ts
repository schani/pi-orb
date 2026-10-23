import { HistorySearchRequestSchema, type OrbSpawnRequest, previewHost } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { acceptsCentralAgentCaller } from "./agent-authorization.ts";
import { requestOrbArchive, requestOrbDeletion, requestOrbSleep } from "./lifecycle.ts";
import type { OrbRow } from "./orb.ts";
import { sendOrbMessage } from "./orb-messaging.ts";
import { normalizeOrbName } from "./orb-naming.ts";
import { getOrbSpawnRelations, spawnOrb } from "./orb-spawning.ts";
import { orbToolRequestId } from "./orb-tool-request-id.ts";
import type { CentralAgentCaller, ControlPlaneDeps } from "./ports.ts";

export interface OrbAgentIdentity {
  readonly ownerUserId?: string;
  readonly projectId: string;
  readonly orbId: string;
  readonly incarnation: number;
  readonly runtimeTokenHash: string;
}
export type OrbAgentRequest =
  | { kind: "self" | "list" | "archive" | "delete" | "notification_admission" }
  | { kind: "transcript"; orbId: string }
  | { kind: "search"; request: unknown }
  | ({ kind: "spawn" } & OrbSpawnRequest)
  | { kind: "alert"; message: string }
  | { kind: "send"; orbId: string; message: string }
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
  ) => ResultAsync<{ recordId: string; duplicate: boolean }, OrbAgentError>;
}
const failure = (code: OrbAgentError["code"], message: string): OrbAgentError => ({
  code,
  message,
});
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
  const item = (
    orb: OrbRow,
    project: { id: string; name: string; repositoryUrl: string | null },
  ) => ({
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
          if (
            !project.value ||
            (identity.ownerUserId !== undefined &&
              project.value.ownerUserId !== identity.ownerUserId)
          )
            return err(failure("unauthorized", "agent identity rejected"));
          if (
            central !== null &&
            !acceptsCentralAgentCaller(orb, project.value.ownerUserId, central)
          )
            return err(failure("unauthorized", "agent identity rejected"));
          const ownerUserId = project.value.ownerUserId;
          if (!requestId) return err(failure("invalid_request", "request ID required"));
          switch (request.kind) {
            case "notification_admission":
              return central !== null
                ? ok({ accepted: true })
                : err(failure("unauthorized", "central agent required"));
            case "self": {
              const relations = await getOrbSpawnRelations(
                task,
                deps.store,
                orb.id,
                options.appOrigin,
              );
              if (relations.isErr()) return err(unavailable());
              return ok({
                orb: {
                  id: orb.id,
                  name: orb.name,
                  url: url(orb.id),
                  createdAt: new Date(orb.createdAt).toISOString(),
                },
                project: item(orb, project.value).project,
                ...relations.value,
                previewHost:
                  options.tailnetDnsName === undefined
                    ? null
                    : previewHost(orb.id, options.tailnetDnsName),
              });
            }
            case "list": {
              const projects = await deps.store.listProjectsByOwner(task, ownerUserId);
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
            case "search": {
              const started = task.wallNow();
              let scope = "invalid";
              const fail = (code: OrbAgentError["code"], message: string) => {
                task.log(
                  `history-search: scope=${scope} error=${code} durationMs=${Math.max(0, task.wallNow() - started)}`,
                );
                return err(failure(code, message));
              };
              const search = request.request;
              if (!Check(HistorySearchRequestSchema, search))
                return fail("invalid_request", "invalid history search request");
              scope = search.scope ?? "orb";
              if (search.orbId !== undefined && (!search.orbId.trim() || scope !== "orb"))
                return fail("invalid_request", "invalid history search request");
              if (orb.state === "deleting")
                return fail("conflict", "orb is being permanently deleted");
              const orbId = scope === "orb" ? (search.orbId ?? orb.id) : undefined;
              if (orbId !== undefined && orbId !== orb.id) {
                const target = await deps.store.getOrb(task, orbId);
                if (target.isErr()) return fail("unavailable", "history search unavailable");
                if (!target.value) return fail("not_found", "orb not found");
                const targetProject = await deps.store.getProject(task, target.value.projectId);
                if (targetProject.isErr()) return fail("unavailable", "history search unavailable");
                if (!targetProject.value || targetProject.value.ownerUserId !== ownerUserId)
                  return fail("not_found", "orb not found");
                if (target.value.state === "deleting")
                  return fail("conflict", "orb is being permanently deleted");
              }
              const result = await deps.store.searchHistory(task, {
                ownerUserId,
                ...(scope === "project" ? { projectId: orb.projectId } : {}),
                ...(orbId === undefined ? {} : { orbId }),
                query: search.query.trim(),
                limit: search.limit ?? 10,
              });
              if (result.isErr()) return fail("unavailable", "history search unavailable");
              const hits = result.value.hits.map((hit) => ({ ...hit, orbUrl: url(hit.orbId) }));
              task.log(
                `history-search: scope=${scope} documents=${result.value.documentCount} candidates=${result.value.candidateCount} hits=${hits.length} durationMs=${Math.max(0, task.wallNow() - started)}`,
              );
              return ok({ hits });
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
                  ...(request.model === undefined ? {} : { model: request.model }),
                },
                caller,
              );
              if (result.isErr())
                return err(
                  result.error.type === "spawn_conflict"
                    ? failure("conflict", "spawn conflicts with existing work")
                    : result.error.type === "spawn_model_error"
                      ? failure(
                          result.error.reason === "unavailable" ? "unavailable" : "invalid_request",
                          result.error.message,
                        )
                      : unavailable(),
                );
              return ok({ orbId: id, projectId: orb.projectId, messageId: id, url: url(id) });
            }
            case "send":
              return await sendOrbMessage(
                task,
                deps,
                {
                  orbId: orb.id,
                  projectId: identity.projectId,
                  ownerUserId,
                  caller,
                },
                {
                  orbId: request.orbId,
                  message: request.message,
                  messageId: orbToolRequestId(orb.id, requestId),
                },
              );
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
