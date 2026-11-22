import type { OrbRow } from "./orb.ts";
import type { ArchiveCaller, CentralAgentCaller, GuestAgentCaller } from "./ports.ts";

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

const activeGuestStates: readonly OrbRow["state"][] = ["creating", "starting", "running"];

function acceptsGuestIncarnation(orb: OrbRow, caller: GuestAgentCaller): boolean {
  return (
    orb.runtimeTokenHash === caller.runtimeTokenHash &&
    orb.hostIncarnation === caller.hostIncarnation &&
    orb.hostDiscardThroughIncarnation === null
  );
}

export function acceptsOrbBootCaller(orb: OrbRow, caller: GuestAgentCaller): boolean {
  return (
    acceptsGuestIncarnation(orb, caller) &&
    (activeGuestStates.includes(orb.state) || orb.state === "stopping" || orb.state === "archiving")
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
    : orb.state === "running" && acceptsGuestIncarnation(orb, caller);
}

export function acceptsPendingModelCaller(
  orb: OrbRow,
  ownerUserId: string | undefined,
  caller: ArchiveCaller,
): boolean {
  if (caller.kind === "central")
    return orb.harness === "pi" && acceptsOrbAgentCaller(orb, ownerUserId, caller);
  return (
    orb.harness === "claude" &&
    activeGuestStates.includes(orb.state) &&
    acceptsGuestIncarnation(orb, caller)
  );
}
