import { parseHelpArgs } from "./cli-help.ts";

const result = parseHelpArgs(process.argv.slice(2));
if (result.isErr()) {
  process.stderr.write(result.error.message);
  process.exitCode = 2;
} else {
  process.stdout.write(result.value);
}
