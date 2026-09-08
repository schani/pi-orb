import { readBrokerEnv } from "../broker/endpoint.ts";
import {
  HOSTING_USAGE,
  listHostedFiles,
  parseHostingArgs,
  removeHostedFile,
  uploadHostedFile,
} from "./command.ts";

const parsed = parseHostingArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = 2;
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${HOSTING_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const action = parsed.value;
  const result =
    action.type === "publish"
      ? await uploadHostedFile(env, action)
      : action.type === "remove"
        ? await removeHostedFile(env, action.path)
        : await listHostedFiles(env);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = result.error.code === "invalid_request" ? 2 : 6;
  } else if ("file" in result.value) {
    process.stdout.write(`${result.value.file.url}\n`);
  } else if ("files" in result.value) {
    for (const file of result.value.files) process.stdout.write(`${file.path}\t${file.url}\n`);
  }
}
