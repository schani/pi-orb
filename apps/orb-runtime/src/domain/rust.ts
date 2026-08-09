import { execFile } from "node:child_process";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";

export interface RustToolchainError {
  readonly type: "rust_toolchain_error";
  readonly message: string;
}

type RustupRunner = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => ResultAsync<string, RustToolchainError>;

const runRustup: RustupRunner = (args, environment) =>
  ResultAsync.fromPromise(
    new Promise<string>((resolve, reject) => {
      execFile(
        "rustup",
        [...args],
        { env: environment, timeout: 15 * 60_000 },
        (error, stdout, stderr) => {
          if (error !== null) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout.trim());
        },
      );
    }),
    (error): RustToolchainError => ({
      type: "rust_toolchain_error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );

/**
 * Points rustup and Cargo at durable orb state, then ensures `cargo` works.
 * Existing defaults are left untouched; a fresh orb downloads stable once.
 */
export function ensurePersistentRustToolchain(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: RustupRunner = runRustup,
): ResultAsync<void, RustToolchainError> {
  const cargoHome = join(home, ".cargo");
  environment.RUSTUP_HOME = join(home, ".rustup");
  environment.CARGO_HOME = cargoHome;
  environment.PATH = `${join(cargoHome, "bin")}:${environment.PATH ?? ""}`;

  return runner(["default"], environment)
    .orElse(() => runner(["default", "stable"], environment))
    .map(() => undefined);
}
