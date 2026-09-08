import process from "node:process";
import { NoSimulationTask } from "determined";
import { NodeSupervisorPorts } from "../adapters.ts";
import { supervise } from "../core.ts";

const command = JSON.parse(process.env["SUPERVISOR_TEST_COMMAND"] ?? "null") as unknown;
if (
  !Array.isArray(command) ||
  command.length === 0 ||
  !command.every((value) => typeof value === "string")
)
  process.exit(2);
const healthUrl = process.env["SUPERVISOR_TEST_HEALTH_URL"];
const diagnostic = process.env["SUPERVISOR_TEST_DIAGNOSTIC"];
if (healthUrl === undefined || diagnostic === undefined) process.exit(2);

const ports = new NodeSupervisorPorts({
  command: command as [string, ...string[]],
  healthUrl,
  diagnostic,
});
const spawn = ports.spawn.bind(ports);
ports.spawn = () => {
  const spawned = spawn();
  if (spawned.isOk()) process.send?.({ runtimePid: spawned.value.pid });
  return spawned;
};

const result = await supervise(
  new NoSimulationTask("runtime supervisor process fixture", false),
  ports,
);
if (result.isErr()) process.exit(1);
if (result.value.type === "exit") process.exit(result.value.code);
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.kill(process.pid, result.value.signal);
