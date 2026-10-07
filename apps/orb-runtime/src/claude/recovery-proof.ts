import { type ClaudeRecoveryProof, ClaudeRecoveryProofSchema } from "@pi-orb/protocol";
import { Result } from "neverthrow";
import { Check } from "typebox/value";

/** Read the launch contract before hooks or project environment are applied. */
export function readClaudeRecoveryProof(
  value: string | undefined,
): ClaudeRecoveryProof | undefined {
  if (value === undefined || value === "" || value.length > 512) return undefined;
  const parsed = Result.fromThrowable(
    (): unknown => JSON.parse(value),
    () => null,
  )();
  return parsed.isOk() && Check(ClaudeRecoveryProofSchema, parsed.value) ? parsed.value : undefined;
}
