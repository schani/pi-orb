import type { OrbView, ProjectView } from "@pi-orb/protocol";
import type { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

export function projectView(project: ProjectRow): ProjectView {
  return {
    id: project.id,
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    createdAt: iso(project.createdAt),
  };
}

/**
 * Fold an orb row plus in-memory reconciler state into the browser view
 * (DESIGN.md §11.3). `actionRequired` and `stateDetail` are synthesized, never
 * stored; no host ref, credential, session ID, or replication field leaks.
 */
export function orbView(orb: OrbRow, control: ControlState): OrbView {
  const challenge = control.getChallenge();
  const showChallenge =
    challenge !== null &&
    (orb.state === "creating" || orb.state === "starting") &&
    control.isAuthBlocked(orb.id) &&
    challenge.verificationUri !== "";
  const drain = orb.state === "stopping" ? control.getDrainStatus(orb.id) : null;
  return {
    id: orb.id,
    projectId: orb.projectId,
    state: orb.state,
    stateVersion: orb.stateVersion,
    ...(orb.checkoutCommit !== null ? { checkoutCommit: orb.checkoutCommit } : {}),
    ...(orb.lastError !== null ? { lastError: orb.lastError } : {}),
    ...(drain !== null
      ? {
          stateDetail: {
            type: "draining_history" as const,
            retrying: drain.retrying,
            ...(drain.message !== undefined ? { message: drain.message } : {}),
          },
        }
      : {}),
    stateChangedAt: iso(orb.stateChangedAt),
    ...(showChallenge
      ? {
          actionRequired: {
            type: "openai_codex_device_login" as const,
            verificationUri: challenge.verificationUri,
            userCode: challenge.userCode,
            expiresAt: iso(challenge.expiresAt),
          },
        }
      : {}),
    createdAt: iso(orb.createdAt),
    updatedAt: iso(orb.updatedAt),
  };
}
