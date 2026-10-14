import { readBrokerEnv } from "../broker/endpoint.ts";
import { parseSendArgs, SEND_USAGE, sendMessage } from "./command.ts";

const parsed = parseSendArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = 2;
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${SEND_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await sendMessage(parsed.value, {
    baseUrl: env.controlPlaneUrl,
    token: env.runtimeToken,
  });
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Message queued (${result.value.messageId}; request-id ${result.value.requestId}).\n`,
    );
}
