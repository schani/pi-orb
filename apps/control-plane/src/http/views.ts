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

/** First matching detail wins; the order is the user-facing priority order. */
function stateDetailOf(
  orb: OrbRow,
  control: ControlState,
  drain: ReturnType<ControlState["getDrainStatus"]>,
  bootProbe: ReturnType<ControlState["getBootProbe"]>,
): OrbView["stateDetail"] {
  if (orb.state === "deleting") {
    return {
      type: "deleting_resources",
      retrying: orb.lastError !== null,
      ...(orb.lastError !== null ? { message: orb.lastError } : {}),
    };
  }
  if (orb.hostDiscardThroughIncarnation !== null) {
    // A spec replacement is routine deploy hygiene, not a failure: the user
    // must not be told their orb failed (docs/compute-replacement.md).
    return {
      type:
        orb.hostDiscardReason === "host_spec_changed"
          ? "replacing_stale_compute"
          : "discarding_failed_compute",
      retrying: orb.hostDiscardError !== null,
      ...(orb.hostDiscardError !== null ? { message: orb.hostDiscardError } : {}),
    };
  }
  if (orb.state === "archiving") {
    return {
      type: "archiving_orb",
      phase:
        control.getLiveness(orb.id)?.activity === "busy" ? "waiting_for_idle" : "sealing_history",
      retrying: orb.lastError !== null,
      ...(orb.lastError !== null ? { message: orb.lastError } : {}),
    };
  }
  if (drain !== null) {
    return {
      type: "draining_history",
      retrying: drain.retrying,
      ...(drain.message !== undefined ? { message: drain.message } : {}),
    };
  }
  if (
    bootProbe?.setupRunning &&
    // Only while the runtime is actually answering: a runtime that died
    // mid-hook must read as "waiting for the runtime", not as a script that
    // is still working.
    bootProbe.lastProbeAnswered &&
    bootProbe.setupRunningSinceWall !== null
  ) {
    // More specific than "waiting for the runtime": the runtime is up and
    // answering, and the repository's own script is what the orb waits on
    // (docs/orb-setup-hook.md).
    return {
      type: "running_setup",
      secondsRunning: Math.max(
        0,
        Math.round((Date.now() - bootProbe.setupRunningSinceWall) / 1000),
      ),
    };
  }
  if (bootProbe !== null) {
    return {
      type: "waiting_for_runtime",
      hostState: bootProbe.hostState,
      secondsSinceHostRunning:
        bootProbe.hostRunningSinceWall === null
          ? null
          : Math.max(0, Math.round((Date.now() - bootProbe.hostRunningSinceWall) / 1000)),
      probeAttempts: bootProbe.attempts,
      ...(bootProbe.lastError !== undefined ? { lastProbeError: bootProbe.lastError } : {}),
    };
  }
  const hookFailure = orb.state === "running" ? control.getHookFailure(orb.id) : null;
  if (hookFailure !== null) {
    // Only while running: the verdict is the one this process last heard from
    // the runtime and describes the boot that is serving right now. On a
    // stopped orb, or during the next boot before its first health report, it
    // would describe compute that is not there. The orb is running regardless
    // (docs/orb-setup-hook.md); this only says the environment its hooks were
    // meant to prepare may be incomplete.
    return {
      type: "setup_failed",
      hook: hookFailure.hook,
      reason: hookFailure.reason,
      logPath: hookFailure.logPath,
    };
  }
  return undefined;
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
  const stateDetail = stateDetailOf(orb, control, drain, bootProbe);
  return {
    id: orb.id,
    projectId: orb.projectId,
    name: orb.name,
    state: orb.state,
    stateVersion: orb.stateVersion,
    ...(liveness !== null ? { activity: liveness.activity } : {}),
    ...(orb.checkoutCommit !== null ? { checkoutCommit: orb.checkoutCommit } : {}),
    ...(orb.lastError !== null ? { lastError: orb.lastError } : {}),
    ...(stateDetail !== undefined ? { stateDetail } : {}),
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
