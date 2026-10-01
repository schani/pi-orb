import type { CreateOrbRequest } from "@pi-orb/protocol";

export function createOrbRequest(id: string): CreateOrbRequest {
  let userTimeZone: string | undefined;
  try {
    userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Browser time zone is optional; creation still works without it.
  }
  return userTimeZone ? { id, userTimeZone } : { id };
}
