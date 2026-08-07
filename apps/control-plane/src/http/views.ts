import { type OrbView, type ProjectView, previewHost } from "@pi-orb/protocol";
import type { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";

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
      : bootProbe !== null
        ? {
            stateDetail: {
              type: "waiting_for_runtime" as const,
              hostState: bootProbe.hostState,
              secondsSinceHostRunning:
                bootProbe.hostRunningSinceWall === null
                  ? null
                  : Math.max(0, Math.round((Date.now() - bootProbe.hostRunningSinceWall) / 1000)),
              probeAttempts: bootProbe.attempts,
              ...(bootProbe.lastError !== undefined ? { lastProbeError: bootProbe.lastError } : {}),
            },
          }
        : {}),
    ...(orb.stopReason !== null ? { stopReason: orb.stopReason } : {}),
    stateChangedAt: iso(orb.stateChangedAt),
    ...(config.tailnetDnsName === undefined
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
