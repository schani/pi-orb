import type { HarnessKind } from "@pi-orb/protocol";
import type { OrbRow } from "./orb.ts";

export function newOrbRow(
  params: {
    orbId: string;
    projectId: string;
    name?: string;
    userTimeZone?: string;
    harness?: HarnessKind;
    initialModel?: OrbRow["initialModel"];
  },
  hostKind: string,
  now: number,
): OrbRow {
  return {
    id: params.orbId,
    projectId: params.projectId,
    harness: params.harness ?? "pi",
    initialModel: params.initialModel ?? null,
    name: params.name ?? null,
    userTimeZone: params.userTimeZone ?? null,
    autoNameLeaseUntil: null,
    autoNameAttempts: 0,
    autoNameNextAttemptAt: null,
    state: "creating",
    stateVersion: 0,
    hostKind,
    hostRef: null,
    hostIncarnation: 0,
    hostSpecFingerprint: null,
    hostSpecGeneration: null,
    hostDiscardThroughIncarnation: null,
    hostDiscardReason: null,
    hostDiscardError: null,
    hostDiscardEvidence: null,
    hostDiscardRequestedAt: null,
    checkoutCommit: null,
    resourceWarnings: [],
    lastReadyAt: null,
    harnessSessionId: null,
    harnessSessionHeader: null,
    lastError: null,
    runtimeTokenHash: null,
    replicationCursor: null,
    replicatedHeadId: null,
    unreadAlertId: null,
    lastBusyAt: null,
    uploadActiveUntil: null,
    stopReason: null,
    agentAdmissionVersion: 0,
    sleepId: null,
    sleepUntil: null,
    lastMintAt: null,
    autoRestartTimes: [],
    stateChangedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
