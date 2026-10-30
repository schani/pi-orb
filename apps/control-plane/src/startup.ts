import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

export const STARTUP_PHASES = [
  "bootstrap.enter",
  "module.enter",
  "main.enter",
  "platform-skills.start",
  "platform-skills.complete",
  "auth-directory.start",
  "auth-directory.complete",
  "database-open.start",
  "database-open.complete",
  "database-migrate.start",
  "database-migrate.complete",
  "secrets.start",
  "secrets.complete",
  "host.start",
  "host.complete",
  "hosting-store.start",
  "hosting-store.complete",
  "http.start",
  "http.complete",
  "central-factory.start",
  "central-factory.complete",
  "auth.start",
  "auth.complete",
  "browser-register.start",
  "browser-register.complete",
  "static.start",
  "browser-initialize.start",
  "websocket.start",
  "websocket.complete",
  "browser-initialize.complete",
  "static.complete",
  "hosting-routes.start",
  "hosting-routes.complete",
  "listen.start",
  "listen.complete",
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export function createStartupLogger(
  now: () => number,
  write: (line: string) => void,
): (phase: StartupPhase) => void {
  const started = now();
  return (phase) => {
    // Diagnostic sink failures must not change application startup semantics.
    try {
      write(
        `${JSON.stringify({
          event: "control-plane-startup",
          phase,
          elapsed_ms: Math.floor(now() - started),
        })}\n`,
      );
    } catch {
      // The stdout adapter is best-effort, including a closed pipe.
    }
  };
}

export const startupPhase = createStartupLogger(
  () => performance.now(),
  (line) => {
    writeSync(1, line);
  },
);
