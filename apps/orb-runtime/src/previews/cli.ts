import { readBrokerEnv } from "../broker/endpoint.ts";
import { PREVIEW_USAGE, parsePreviewArgs } from "./command.ts";
import { requestPreviews } from "./endpoint.ts";

const parsed = parsePreviewArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error}\n`);
  process.exitCode = 2;
} else if (env === null) {
  process.stderr.write(
    `pi-orb: orb runtime environment missing (not inside an orb?)\n${PREVIEW_USAGE}\n`,
  );
  process.exitCode = 2;
} else {
  const result = await requestPreviews(env, parsed.value);
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = 6;
  } else if ("preview" in result.value) {
    process.stdout.write(`${result.value.preview.url}\n`);
  } else if ("previews" in result.value) {
    process.stdout.write(
      parsed.value.type === "previews" && parsed.value.json
        ? `${JSON.stringify(result.value, null, 2)}\n`
        : result.value.previews.map((item) => `${item.port}\t${item.url}\n`).join(""),
    );
  }
}
