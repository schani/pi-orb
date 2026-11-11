import { readBrokerEnv } from "../broker/endpoint.ts";
import { LINK_USAGE, parseLinkArgs, requestLink } from "./command.ts";

const parsed = parseLinkArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error}\n`);
  process.exitCode = 2;
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${LINK_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await requestLink(env, parsed.value);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error}\n`);
    process.exitCode = 6;
  } else process.stdout.write(`${result.value}\n`);
}
