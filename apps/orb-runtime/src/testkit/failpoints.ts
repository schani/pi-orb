/**
 * Named failpoint vocabulary for the runtime's own simulations, mirroring the
 * control plane's `testkit/failpoints.ts` (workspaces cannot import each
 * other's testkits). Probabilities are configured per test by name.
 */
export const HOOK_FAILPOINTS = {
  /** The status file a hook run leaves beside its log. */
  statusWrite: "hooks.status.write",
  /** The durable "setup has run for this incarnation" stamp on the workspace. */
  stampWrite: "hooks.stamp.write",
} as const;

export type HookFailpointName = (typeof HOOK_FAILPOINTS)[keyof typeof HOOK_FAILPOINTS];
