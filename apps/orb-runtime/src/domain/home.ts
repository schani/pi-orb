import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Result } from "neverthrow";

export interface PersistentHomeError {
  readonly type: "persistent_home_error";
  readonly message: string;
}

export function persistentHomePath(workDir: string): string {
  return join(workDir, "home");
}

/**
 * Establish the orb's Unix home inside its authoritative persistent filesystem.
 * Providers set HOME too, but the runtime enforces the contract so alternate
 * hosts and direct launches cannot silently write durable-looking state into a
 * disposable or shared host home.
 */
export function configurePersistentHome(
  workDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Result<string, PersistentHomeError> {
  const home = persistentHomePath(workDir);
  return Result.fromThrowable(
    () => {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      environment.HOME = home;
      return home;
    },
    (error): PersistentHomeError => ({
      type: "persistent_home_error",
      message: error instanceof Error ? error.message : String(error),
    }),
  )();
}
