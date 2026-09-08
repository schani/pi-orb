import { execFile } from "node:child_process";
import type { RustToolchainEvent } from "../domain/rust.ts";

type DiagnosticRunner = (args: readonly string[], timeoutMs: number, done: () => void) => void;

const runDiagnostic: DiagnosticRunner = (args, timeoutMs, done) => {
  execFile("/usr/local/bin/pi-orb-boot-diagnostic", [...args], { timeout: timeoutMs }, () =>
    done(),
  );
};

export async function reportRustToolchainEdge(
  event: RustToolchainEvent,
  timeoutMs: number,
  runner: DiagnosticRunner = runDiagnostic,
  log: (message: string) => void = console.log,
): Promise<void> {
  log(`rust toolchain: ${JSON.stringify(event)}`);
  const recovered = event.type === "recovered";
  const details = recovered
    ? { attempt: event.attempt }
    : { attempt: event.attempt, delayMs: event.delayMs, errorClass: event.errorClass };
  await new Promise<void>((resolve) => {
    runner(
      [
        "runtime",
        "event",
        recovered ? "rust_toolchain_recovered" : "rust_toolchain_retry",
        "",
        JSON.stringify(details),
      ],
      timeoutMs,
      resolve,
    );
  });
}
