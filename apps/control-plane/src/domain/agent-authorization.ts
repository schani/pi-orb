import type { OrbRow } from "./orb.ts";
import type { ArchiveCaller, CentralAgentCaller } from "./ports.ts";

export function acceptsCentralAgentCaller(
  orb: OrbRow,
  ownerUserId: string | undefined,
  caller: CentralAgentCaller,
): boolean {
  return (
    orb.id === caller.orbId &&
    orb.projectId === caller.projectId &&
    ownerUserId === caller.ownerUserId &&
    orb.agentAdmissionVersion === caller.agentAdmissionVersion &&
    orb.stopReason !== "manual" &&
    orb.stopReason !== "sleep" &&
    !["archived", "deleting"].includes(orb.state)
  );
}

export function acceptsOrbAgentCaller(
  orb: OrbRow,
  ownerUserId: string | undefined,
  caller: ArchiveCaller,
): boolean {
  return caller.kind === "central"
    ? orb.sleepId === null &&
        orb.state !== "archiving" &&
        acceptsCentralAgentCaller(orb, ownerUserId, caller)
    : orb.state === "running" &&
        orb.runtimeTokenHash === caller.runtimeTokenHash &&
        orb.hostIncarnation === caller.hostIncarnation &&
        orb.hostDiscardThroughIncarnation === null;
}
