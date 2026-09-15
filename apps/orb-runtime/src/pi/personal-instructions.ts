import { createHash } from "node:crypto";
import type { PersonalInstructions } from "@pi-orb/protocol";

export const PERSONAL_INSTRUCTIONS_ADOPTION = "pi-orb:personal-instructions";

/** Edge-only metadata. Content goes to model context, never into this history record. */
export function personalInstructionsAdoption(snapshot: PersonalInstructions, previous: unknown) {
  if (previous === null && snapshot.revision === 0 && snapshot.content === "") return null;
  const next = {
    revision: snapshot.revision,
    sha256: createHash("sha256").update(snapshot.content).digest("hex"),
  };
  if (
    typeof previous === "object" &&
    previous !== null &&
    "revision" in previous &&
    "sha256" in previous &&
    previous.revision === next.revision &&
    previous.sha256 === next.sha256
  )
    return null;
  return next;
}
