import { execFile } from "node:child_process";
import { join } from "node:path";
import { errAsync, ResultAsync } from "neverthrow";

export interface RustToolchainError {
  readonly type: "rust_toolchain_error";
  readonly message: string;
  readonly retryable?: boolean;
}

type RustupRunner = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
) => ResultAsync<string, RustToolchainError>;

export type RustToolchainEvent =
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly delayMs: number;
      readonly errorClass: RustToolchainTransientErrorClass;
    }
  | { readonly type: "recovered"; readonly attempt: number };

export type RustToolchainTransientErrorClass =
  | "dns"
  | "network_unreachable"
  | "connection_reset"
  | "connection_refused"
  | "timeout"
  | "http_429"
  | "http_5xx";

export interface RustToolchainRetryDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (event: RustToolchainEvent, timeoutMs: number) => Promise<void>;
}

const INSTALL_RETRY_DELAYS_MS = [5_000, 15_000] as const;
const RUST_SETUP_BUDGET_MS = 3 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export function classifyRustupFailure(error: unknown): RustToolchainError {
  return {
    type: "rust_toolchain_error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "retryable" in error && error.retryable === true
      ? { retryable: true }
      : {}),
  };
}

export function rustupExecFailure(
  error: Error & { readonly killed?: boolean },
  stderr: string,
): Error & { retryable?: boolean } {
  const failure = new Error(stderr.trim() || error.message) as Error & { retryable?: boolean };
  failure.retryable = error.killed === true;
  return failure;
}

const runRustup: RustupRunner = (args, environment, timeoutMs) =>
  ResultAsync.fromPromise(
    new Promise<string>((resolve, reject) => {
      execFile(
        "rustup",
        [...args],
        { env: environment, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error !== null) reject(rustupExecFailure(error, stderr));
          else resolve(stdout.trim());
        },
      );
    }),
    classifyRustupFailure,
  );

const transientErrorClass = (
  error: RustToolchainError,
): RustToolchainTransientErrorClass | undefined => {
  if (error.retryable === true || /(?:operation )?timed out/i.test(error.message)) return "timeout";
  if (
    /dns error|temporary failure in name resolution|failed to lookup address/i.test(error.message)
  )
    return "dns";
  if (/network is unreachable/i.test(error.message)) return "network_unreachable";
  if (/connection reset/i.test(error.message)) return "connection_reset";
  if (/connection refused/i.test(error.message)) return "connection_refused";
  if (/http (?:status |request returned an unsuccessful status code: )429/i.test(error.message))
    return "http_429";
  if (/http (?:status |request returned an unsuccessful status code: )5\d\d/i.test(error.message))
    return "http_5xx";
  return undefined;
};

/**
 * Points rustup and Cargo at durable orb state, then ensures `cargo` works.
 * Existing defaults are left untouched; a fresh orb downloads stable once.
 */
export function ensurePersistentRustToolchain(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: RustupRunner = runRustup,
  retry: RustToolchainRetryDeps = {
    now: performance.now.bind(performance),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    report: async (event) => console.log(`rust toolchain: ${JSON.stringify(event)}`),
  },
): ResultAsync<void, RustToolchainError> {
  const cargoHome = join(home, ".cargo");
  environment.RUSTUP_HOME = join(home, ".rustup");
  environment.CARGO_HOME = cargoHome;
  environment.PATH = `${join(cargoHome, "bin")}:${environment.PATH ?? ""}`;
  const deadline = retry.now() + RUST_SETUP_BUDGET_MS;

  const install = (
    attempt: number,
  ): ResultAsync<{ value: string; attempt: number }, RustToolchainError> => {
    const timeoutMs = Math.floor(deadline - retry.now());
    if (timeoutMs <= 0) {
      return errAsync({ type: "rust_toolchain_error", message: "Rust setup deadline exceeded" });
    }
    return runner(["default", "stable"], environment, timeoutMs)
      .map((value) => ({ value, attempt }))
      .orElse((error) => {
        const delay = INSTALL_RETRY_DELAYS_MS[attempt - 1];
        const errorClass = transientErrorClass(error);
        if (delay === undefined || errorClass === undefined || retry.now() + delay >= deadline)
          return errAsync(error);
        return ResultAsync.fromSafePromise(
          retry.report(
            { type: "retry", attempt: attempt + 1, delayMs: delay, errorClass },
            Math.max(1, Math.floor(deadline - retry.now())),
          ),
        )
          .andThen(() =>
            retry.now() + delay < deadline
              ? ResultAsync.fromSafePromise(retry.sleep(delay))
              : errAsync(error),
          )
          .andThen(() => (retry.now() < deadline ? install(attempt + 1) : errAsync(error)));
      });
  };

  return runner(["default"], environment, DEFAULT_PROBE_TIMEOUT_MS)
    .orElse(() => install(1))
    .andThen((installed) => {
      if (typeof installed !== "string" && installed.attempt > 1) {
        return ResultAsync.fromSafePromise(
          retry.report(
            { type: "recovered", attempt: installed.attempt },
            Math.max(1, Math.floor(deadline - retry.now())),
          ),
        );
      }
      return ResultAsync.fromSafePromise(Promise.resolve());
    });
}
