import { readBrokerEnv } from "../broker/endpoint.ts";
import { parseSleepArgs, requestSelfSleep, SLEEP_USAGE, sleepExitCode } from "./command.ts";

const parsed = parseSleepArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = sleepExitCode(parsed.error);
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${SLEEP_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await requestSelfSleep(env, parsed.value);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = sleepExitCode(result.error);
  } else {
    process.stdout.write(`Sleep scheduled until ${result.value.sleepUntil}.\n`);
  }
}
