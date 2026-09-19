import { readBrokerEnv } from "../broker/endpoint.ts";
import { DELETE_USAGE, deleteExitCode, parseDeleteArgs, requestSelfDelete } from "./command.ts";

const parsed = parseDeleteArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = deleteExitCode(parsed.error);
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${DELETE_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await requestSelfDelete(env);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = deleteExitCode(result.error);
  } else {
    process.stdout.write(
      "Deletion requested. Workspace, conversation, and hosted files will be permanently deleted; this turn may be interrupted.\n",
    );
  }
}
