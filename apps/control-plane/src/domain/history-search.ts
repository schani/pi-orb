import {
  type HistorySearchRequest,
  HistorySearchRequestSchema,
  type HistorySearchResult,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { OrbRow } from "./orb.ts";
import type { OrbAgentError } from "./orb-agent-operations.ts";
import type { ControlPlaneDeps, ControlPlaneStore } from "./ports.ts";

export interface HistorySearchIdentity {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly orbId: string;
}

export function searchGuestOrbHistory(
  task: SimulationTask,
  deps: Pick<ControlPlaneDeps, "store">,
  source: OrbRow,
  request: HistorySearchRequest,
  appOrigin: string,
): ResultAsync<HistorySearchResult, OrbAgentError> {
  return new ResultAsync(
    (async () => {
      const current = await deps.store.getOrb(task, source.id);
      if (current.isErr())
        return err({ code: "unavailable" as const, message: "history search unavailable" });
      const orb = current.value;
      if (
        !orb ||
        orb.projectId !== source.projectId ||
        source.runtimeTokenHash === null ||
        orb.runtimeTokenHash !== source.runtimeTokenHash ||
        orb.hostIncarnation !== source.hostIncarnation ||
        orb.hostDiscardThroughIncarnation !== null
      )
        return err({ code: "unauthorized" as const, message: "agent identity rejected" });
      const project = await deps.store.getProject(task, orb.projectId);
      if (project.isErr())
        return err({ code: "unavailable" as const, message: "history search unavailable" });
      if (!project.value)
        return err({ code: "unauthorized" as const, message: "agent project missing" });
      return await searchOrbHistory(
        task,
        deps.store,
        {
          ownerUserId: project.value.ownerUserId,
          projectId: orb.projectId,
          orbId: orb.id,
        },
        request,
        appOrigin,
      );
    })(),
  );
}

export function searchOrbHistory(
  task: SimulationTask,
  store: ControlPlaneStore,
  identity: HistorySearchIdentity,
  request: HistorySearchRequest,
  appOrigin: string,
): ResultAsync<HistorySearchResult, OrbAgentError> {
  const started = task.wallNow();
  let scope = "invalid";
  const failure = (code: OrbAgentError["code"], message: string) => {
    task.log(
      `history-search: scope=${scope} error=${code} durationMs=${Math.max(0, task.wallNow() - started)}`,
    );
    return err<never, OrbAgentError>({ code, message });
  };
  const unavailable = () => failure("unavailable", "history search unavailable");
  return new ResultAsync(
    (async () => {
      const selectedScope = request.scope ?? "orb";
      if (
        !Check(HistorySearchRequestSchema, request) ||
        (request.orbId !== undefined && (!request.orbId.trim() || selectedScope !== "orb"))
      )
        return failure("invalid_request", "invalid history search request");
      scope = selectedScope;
      const orbId = scope === "orb" ? (request.orbId ?? identity.orbId) : undefined;
      if (orbId !== undefined) {
        const target = await store.getOrb(task, orbId);
        if (target.isErr()) return unavailable();
        if (!target.value) return failure("not_found", "orb not found");
        const project = await store.getProject(task, target.value.projectId);
        if (project.isErr()) return unavailable();
        if (!project.value || project.value.ownerUserId !== identity.ownerUserId)
          return failure("not_found", "orb not found");
        if (target.value.state === "deleting")
          return failure("conflict", "orb is being permanently deleted");
      }
      const result = await store.searchHistory(task, {
        ownerUserId: identity.ownerUserId,
        ...(scope === "project" ? { projectId: identity.projectId } : {}),
        ...(orbId === undefined ? {} : { orbId }),
        query: request.query.trim(),
        limit: request.limit ?? 10,
      });
      if (result.isErr()) return unavailable();
      const hits = result.value.hits.map((hit) => ({
        ...hit,
        orbUrl: `${appOrigin}/orbs/${hit.orbId}`,
      }));
      task.log(
        `history-search: scope=${scope} documents=${result.value.documentCount} candidates=${result.value.candidateCount} hits=${hits.length} durationMs=${Math.max(0, task.wallNow() - started)}`,
      );
      return ok({ hits });
    })(),
  );
}
