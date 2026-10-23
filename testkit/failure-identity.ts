/** Match the invariant and its origin, not the runner's recording/replay stack. */
export function failureIdentity(failure: unknown): string {
  const detail = failure instanceof Error ? failure.message : String(failure);
  const origin = (
    detail.includes("\n    at ") ? detail : failure instanceof Error ? failure.stack : detail
  )
    ?.split("\n    at ")[1]
    ?.split("\n")[0];
  return `${detail.split("\n    at ")[0]}\n${origin ?? ""}`;
}
