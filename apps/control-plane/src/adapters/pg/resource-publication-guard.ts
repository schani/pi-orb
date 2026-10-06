import { err, errAsync, ok } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { ResourcePublicationGuard } from "./resource-snapshots.ts";

const revoked = (): StoreError => ({
  type: "store_error",
  code: "invariant",
  message: "Resource publication admission revoked",
  retryable: false,
});
/** Runs within PgResourceSnapshots' transaction, after its orb-row lock. No stale context may publish. */
export function resourcePublicationGuard(options: {
  expectedAdmissionVersion: number;
  signal: AbortSignal;
}): ResourcePublicationGuard {
  return (query, orbId) => {
    if (options.signal.aborted) return errAsync(revoked());
    return query(
      "SELECT state,stop_reason,agent_admission_version FROM orbs WHERE id=$1 FOR UPDATE",
      [orbId],
    ).andThen((result) => {
      const row = result.rows[0];
      if (
        options.signal.aborted ||
        !row ||
        !["creating", "starting", "running", "stopping", "stopped", "failed"].includes(
          String(row.state),
        ) ||
        row.stop_reason === "manual" ||
        row.stop_reason === "sleep" ||
        String(row.agent_admission_version) !== String(options.expectedAdmissionVersion)
      )
        return err(revoked());
      return ok(undefined);
    });
  };
}
