import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Persist before deleting hosted sessions or the fixture's database/runtime files. */
export function preserveMultiUserEvidence(
  directory: string,
  evidence: {
    controlPlaneLog: string;
    inference: readonly unknown[];
    github: readonly unknown[];
    orbs: readonly unknown[];
    sessions: Readonly<Record<string, unknown>>;
  },
): void {
  const { controlPlaneLog, ...diagnostics } = evidence;
  writeFileSync(join(directory, "control-plane.log"), controlPlaneLog);
  writeFileSync(join(directory, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
}
