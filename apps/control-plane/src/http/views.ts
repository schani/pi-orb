import { type OrbView, type ProjectView, previewHost } from "@pi-orb/protocol";
import type { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectDeletionProgress, ProjectRow } from "../domain/orb.ts";

/**
 * Static deployment configuration the view layer derives fields from. It is
 * deliberately separate from `ControlPlaneDeps`: the domain knows nothing
 * about tailscale.
 */
export interface ViewConfig {
  /** MagicDNS suffix; absent when tailscale port exposure is not configured. */
  readonly tailnetDnsName?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function projectView(
  project: ProjectRow,
  deletionProgress?: ProjectDeletionProgress,
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    state: project.state,
    ...(deletionProgress !== undefined ? { deletionProgress } : {}),
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  };
}

/**
 * Fold an orb row plus in-memory reconciler state into the browser view
 * (docs/control-plane-api.md). `actionRequired` and `stateDetail` are synthesized, never
 * stored; no host ref, credential, session ID, or replication field leaks.
 */
export function orbView(orb: OrbRow, control: ControlState, config: ViewConfig): OrbView {
  const challenge = control.getChallenge();
  const showChallenge =
    challenge !== null &&
    (orb.state === "creating" || orb.state === "starting") &&
    control.isAuthBlocked(orb.id) &&
    challenge.verificationUri !== "";
  const drain = orb.state === "stopping" ? control.getDrainStatus(orb.id) : null;
  const liveness = orb.state === "running" ? control.getLiveness(orb.id) : null;
  const bootProbe =
    (orb.state === "creating" || orb.state === "starting") && !showChallenge
      ? control.getBootProbe(orb.id)
      : null;
  return {
    id: orb.id,
    projectId: orb.projectId,
    name: orb.name,
    state: orb.state,
    stateVersion: orb.stateVersion,
    ...(liveness !== null ? { activity: liveness.activity } : {}),
    ...(orb.checkoutCommit !== null ? { checkoutCommit: orb.checkoutCommit } : {}),
    ...(orb.lastError !== null ? { lastError: orb.lastError } : {}),
    ...(orb.state === "deleting"
      ? {
          stateDetail: {
            type: "deleting_resources" as const,
            retrying: orb.lastError !== null,
            ...(orb.lastError !== null ? { message: orb.lastError } : {}),
          },
        }
      : orb.state === "archiving"
        ? {
            stateDetail: {
              type: "archiving_orb" as const,
              phase:
                control.getLiveness(orb.id)?.activity === "busy"
                  ? ("waiting_for_idle" as const)
                  : ("sealing_history" as const),
              retrying: orb.lastError !== null,
              ...(orb.lastError !== null ? { message: orb.lastError } : {}),
            },
          }
        : drain !== null
          ? {
              stateDetail: {
                type: "draining_history" as const,
                retrying: drain.retrying,
                ...(drain.message !== undefined ? { message: drain.message } : {}),
              },
            }
          : bootProbe !== null
            ? {
                stateDetail: {
                  type: "waiting_for_runtime" as const,
                  hostState: bootProbe.hostState,
                  secondsSinceHostRunning:
                    bootProbe.hostRunningSinceWall === null
                      ? null
                      : Math.max(
                          0,
                          Math.round((Date.now() - bootProbe.hostRunningSinceWall) / 1000),
                        ),
                  probeAttempts: bootProbe.attempts,
                  ...(bootProbe.lastError !== undefined
                    ? { lastProbeError: bootProbe.lastError }
                    : {}),
                },
              }
            : {}),
    ...(orb.stopReason !== null ? { stopReason: orb.stopReason } : {}),
    stateChangedAt: iso(orb.stateChangedAt),
    ...(orb.archivedAt != null ? { archivedAt: iso(orb.archivedAt) } : {}),
    ...(config.tailnetDnsName === undefined || orb.state === "archiving" || orb.state === "archived"
      ? {}
      : { previewHost: previewHost(orb.id, config.tailnetDnsName) }),
    ...(showChallenge
      ? {
          actionRequired: {
            type:
              challenge.provider === "github"
                ? ("github_device_login" as const)
                : ("openai_codex_device_login" as const),
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
