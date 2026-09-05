import { readBrokerEnv } from "../broker/endpoint.ts";
import { ARCHIVE_USAGE, archiveExitCode, parseArchiveArgs, requestSelfArchive } from "./command.ts";

const parsed = parseArchiveArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = archiveExitCode(parsed.error);
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${ARCHIVE_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await requestSelfArchive(env);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = archiveExitCode(result.error);
  } else {
    process.stdout.write(
      "Archive requested. This turn may finish; workspace files will be permanently deleted and the conversation retained.\n",
    );
  }
}
