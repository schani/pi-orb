import { readFileSync } from "node:fs";
import { err, ok, Result } from "neverthrow";

interface IdentityError {
  readonly type: "execution_identity_error";
  readonly code: "read_failed" | "invalid_identity";
  readonly message: string;
}
type ReadText = (path: string) => Result<string, IdentityError>;
const readText: ReadText = Result.fromThrowable(
  (path: string) => readFileSync(path, "utf8").trim(),
  (cause): IdentityError => ({
    type: "execution_identity_error",
    code: "read_failed",
    message: String(cause),
  }),
);

/** Container PID 1 defines process lifetime; kernel boot ID alone does not. */
export function readExecutionIdentity(
  environment: Readonly<Record<string, string | undefined>>,
  read: ReadText = readText,
): Result<string | null, IdentityError> {
  if (environment["PI_ORB_CONTAINER"] !== "1") return ok(null);
  return read("/proc/sys/kernel/random/boot_id").andThen((kernelBoot) =>
    read("/proc/1/stat").andThen((stat): Result<string, IdentityError> => {
      // comm (field 2) can contain spaces and parentheses. Fields after its
      // final ')' begin with state (3); starttime is field 22.
      const end = stat.lastIndexOf(")");
      const start =
        end < 0
          ? undefined
          : stat
              .slice(end + 1)
              .trim()
              .split(/\s+/)[19];
      return kernelBoot !== "" && start !== undefined && /^\d+$/.test(start)
        ? ok(`${kernelBoot}:${start}`)
        : err({
            type: "execution_identity_error",
            code: "invalid_identity",
            message: "invalid container execution identity",
          });
    }),
  );
}
