import {
  canonicalGithubLink,
  githubRepository,
  type OrbLinkStatus,
  type OrbLinkStepsResponse,
  type OrbLinksResponse,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import type { OrbLinkStore } from "./orb-link-ports.ts";
import type { ControlPlaneStore } from "./ports.ts";

/** Status per URL (null when GitHub has none), or a user-facing reason for no status at all. */
export type GithubLinkReader = (
  task: SimulationTask,
  ownerUserId: string,
  urls: readonly string[],
) => ResultAsync<
  { readonly statuses: readonly (OrbLinkStatus | null)[]; readonly githubError: string | null },
  string
>;

export type GithubLinkStepsReader = (
  task: SimulationTask,
  ownerUserId: string,
  checkId: string,
) => ResultAsync<OrbLinkStepsResponse, string>;

export interface OrbLinkDeps {
  readonly store: OrbLinkStore & Pick<ControlPlaneStore, "getOrb" | "getProject">;
  readonly github: GithubLinkReader;
  readonly githubSteps: GithubLinkStepsReader;
}

export async function addOrbLink(
  task: SimulationTask,
  store: OrbLinkStore,
  orbId: string,
  url: string,
): Promise<Result<string, { readonly type: "invalid_link" } | StoreError>> {
  const canonical = canonicalGithubLink(url);
  if (canonical === null) return err({ type: "invalid_link" });
  const added = await store.addOrbLink(task, { orbId, url: canonical, now: task.wallNow() });
  if (added.isErr()) return err(added.error);
  if (added.value) logOrbEvent(task, orbId, "link-added", { url: canonical });
  return ok(canonical);
}

export async function removeOrbLink(
  task: SimulationTask,
  store: OrbLinkStore,
  orbId: string,
  url: string,
): Promise<Result<void, StoreError>> {
  const removed = await store.removeOrbLink(task, { orbId, url });
  if (removed.isErr()) return err(removed.error);
  if (removed.value) logOrbEvent(task, orbId, "link-removed", { url });
  return ok(undefined);
}

export async function readOrbLinks(
  task: SimulationTask,
  deps: OrbLinkDeps,
  orbId: string,
): Promise<Result<OrbLinksResponse, { readonly type: "orb_not_found" } | StoreError>> {
  const orb = await deps.store.getOrb(task, orbId);
  if (orb.isErr()) return err(orb.error);
  if (orb.value === null) return err({ type: "orb_not_found" });
  const project = await deps.store.getProject(task, orb.value.projectId);
  if (project.isErr()) return err(project.error);
  if (project.value === null) return err({ type: "orb_not_found" });
  const rows = await deps.store.listOrbLinks(task, orbId);
  if (rows.isErr()) return err(rows.error);
  const repository = githubRepository(project.value.repositoryUrl);
  if (rows.value.length === 0) return ok({ repository, githubError: null, items: [] });
  const statuses = await deps.github(
    task,
    project.value.ownerUserId,
    rows.value.map((row) => row.url),
  );
  return ok({
    repository,
    githubError: statuses.isErr() ? statuses.error : statuses.value.githubError,
    items: rows.value.map((row, index) => ({
      url: row.url,
      addedAt: row.addedAt,
      github: statuses.isOk() ? (statuses.value.statuses[index] ?? null) : null,
    })),
  });
}

export async function readOrbLinkSteps(
  task: SimulationTask,
  deps: OrbLinkDeps,
  orbId: string,
  url: string,
  checkId: string,
): Promise<
  Result<
    OrbLinkStepsResponse,
    { readonly type: "orb_not_found" } | { readonly type: "link_not_found" } | StoreError
  >
> {
  const orb = await deps.store.getOrb(task, orbId);
  if (orb.isErr()) return err(orb.error);
  if (orb.value === null) return err({ type: "orb_not_found" });
  const project = await deps.store.getProject(task, orb.value.projectId);
  if (project.isErr()) return err(project.error);
  if (project.value === null) return err({ type: "orb_not_found" });
  const links = await deps.store.listOrbLinks(task, orbId);
  if (links.isErr()) return err(links.error);
  if (!links.value.some((link) => link.url === url)) return err({ type: "link_not_found" });
  const result = await deps.githubSteps(task, project.value.ownerUserId, checkId);
  return ok(result.isOk() ? result.value : { steps: [], githubError: result.error });
}
