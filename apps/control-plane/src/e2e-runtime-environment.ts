import { err, ok, Result } from "neverthrow";

/**
 * E2E-only extra runtime environment (`PI_ORB_E2E_RUNTIME_ENV`), e.g. git URL rewrites to a
 * local repository fixture. Unset in production compositions.
 */
export function parseE2eRuntimeEnvironment(
  value: string,
): Result<Record<string, string>, { type: "invalid_e2e_runtime_env" }> {
  if (value === "") return ok({});
  const parsed = Result.fromThrowable(
    () => JSON.parse(value) as unknown,
    () => ({ type: "invalid_e2e_runtime_env" as const }),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const object = parsed.value;
  if (
    typeof object !== "object" ||
    object === null ||
    Array.isArray(object) ||
    !Object.values(object).every((entry) => typeof entry === "string")
  )
    return err({ type: "invalid_e2e_runtime_env" });
  return ok(object as Record<string, string>);
}
