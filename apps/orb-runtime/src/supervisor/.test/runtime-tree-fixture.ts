import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const signals = ["SIGTERM", "SIGINT"] as const;
function publish(port: string, phase: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(Number(port), "127.0.0.1", () => {
      console.error(`${process.pid}: ${phase}`);
    });
    socket.once("close", () => resolve());
  });
}

function terminate(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "descendant") {
  const [readyPort, signalledPort] = args as [string, string];
  setInterval(() => {}, 1_000);
  for (const signal of signals)
    process.on(signal, async () => {
      await publish(signalledPort, `descendant received ${signal}; exit held`);
      terminate(signal);
    });
  await publish(readyPort, "descendant handlers ready");
} else {
  const [readyPort, descendantReadyPort, signalledPort, handlingPort, cleanedPort] = args as [
    string,
    string,
    string,
    string,
    string,
  ];
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant", descendantReadyPort, signalledPort],
    { stdio: "inherit" },
  );
  const descendantExit = new Promise<void>((resolve) =>
    descendant.once("exit", (code, signal) => {
      console.error(`${process.pid}: descendant exited code=${code} signal=${signal}`);
      resolve();
    }),
  );
  writeFileSync(mode as string, `${process.pid} ${descendant.pid}`);
  for (const signal of signals)
    process.on(signal, async () => {
      await publish(handlingPort, `runtime received ${signal}; waiting for descendant`);
      await descendantExit;
      await publish(cleanedPort, "descendant reaped; cleanup reported");
      terminate(signal);
    });
  // Hold execution after readiness, including while signal handlers run.
  await publish(readyPort, "runtime handlers ready; execution held");
}
