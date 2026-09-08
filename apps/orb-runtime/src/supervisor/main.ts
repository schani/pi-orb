import process from "node:process";
import { NoSimulationTask } from "determined";
import { NodeSupervisorPorts } from "./adapters.ts";
import { supervise } from "./core.ts";

const result = await supervise(
  new NoSimulationTask("runtime supervisor", false),
  new NodeSupervisorPorts(),
);
if (result.isErr()) {
  console.error(`runtime supervisor: ${result.error.type}: ${result.error.message}`);
  process.exit(1);
}
if (result.value.type === "exit") process.exit(result.value.code);

process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.kill(process.pid, result.value.signal);
