import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { ORB_SPAWN_MAX_BYTES } from "@pi-orb/protocol";
import { err, ok, ResultAsync } from "neverthrow";
import { readBrokerEnv } from "../broker/endpoint.ts";
import { parseSpawnArgs, requestSpawn, type SpawnFailure } from "./command.ts";

function readPrompt(file: string) {
  return ResultAsync.fromThrowable(
    async () => {
      const stream = file === "-" ? process.stdin : createReadStream(file);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > ORB_SPAWN_MAX_BYTES)
          return err<never, SpawnFailure>({
            type: "spawn_failure",
            exitCode: 2,
            message: "prompt exceeds 1 MiB",
          });
        chunks.push(buffer);
      }
      return ok(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    },
    (): SpawnFailure => ({
      type: "spawn_failure",
      exitCode: 2,
      message: "could not read UTF-8 prompt input",
    }),
  )().andThen((result) => result);
}

const parsed = parseSpawnArgs(process.argv.slice(2));
const env = readBrokerEnv(process.env);
if (parsed.isErr()) {
  process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
  process.exitCode = parsed.error.exitCode;
} else if (env === null) {
  process.stderr.write("pi-orb: orb runtime environment missing (not inside an orb?)\n");
  process.exitCode = 2;
} else {
  const args = parsed.value;
  const prompt = "text" in args.source ? ok(args.source.text) : await readPrompt(args.source.file);
  const result = prompt.isErr()
    ? prompt
    : await requestSpawn(env, args.id ?? randomUUID(), {
        prompt: prompt.value,
        ...(args.name === undefined ? {} : { name: args.name }),
      });
  if (result.isErr()) {
    process.stderr.write(`pi-orb: ${result.error.message}\n`);
    process.exitCode = result.error.exitCode;
  } else {
    process.stdout.write(`${args.json ? JSON.stringify(result.value) : result.value.url}\n`);
  }
}
