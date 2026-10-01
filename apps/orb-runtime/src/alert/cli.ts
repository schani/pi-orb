import { RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import { ALERT_USAGE, parseAlertArgs, sendAlert } from "./command.ts";

const parsed = parseAlertArgs(process.argv.slice(2));
const token = process.env[RUNTIME_TOKEN_ENV];
const port = Number(process.env.PI_ORB_RUNTIME_PORT ?? "8080");
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = 2;
} else if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${ALERT_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await sendAlert(parsed.value, { token, port });
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = result.error.code === "invalid_request" ? 2 : 1;
  } else process.stdout.write(`Alert saved (${result.value.id}).\n`);
}
