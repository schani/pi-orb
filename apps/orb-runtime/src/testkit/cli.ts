import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { onTestFinished } from "vitest";

interface CliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Test adapter: rejects only after joining the owned process and removing its cwd. */
export async function runCli(args: readonly string[], options: CliOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-orb-cli-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(options.command ?? join(import.meta.dirname, "../../docker/pi-orb"), args, {
    cwd,
    env: options.env ?? { PATH: process.env.PATH },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  let ended = false;
  const terminate = () => {
    if (ended || child.pid === undefined) return;
    if (process.platform === "win32") child.kill("SIGKILL");
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
  };
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: Error | undefined;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      ended = true;
      resolve();
    }),
  );
  onTestFinished(async () => {
    try {
      terminate();
    } finally {
      await closed;
    }
  });
  const fail = (message: string) => {
    failure ??= Object.assign(new Error(message), { pid: child.pid });
    terminate();
  };
  child.once("error", () => fail("CLI launch failed"));
  child.stdin.on("error", () => {
    /* A command may exit before consuming stdin. */
  });
  const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) return fail("CLI output exceeded");
    if (stream === "stdout") stdout += decoders.stdout.write(chunk);
    else stderr += decoders.stderr.write(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  const deadline = setTimeout(() => fail("CLI deadline exceeded"), options.timeoutMs ?? 15_000);
  child.stdin.end(options.input ?? "");
  await closed;
  clearTimeout(deadline);
  stdout += decoders.stdout.end();
  stderr += decoders.stderr.end();
  const cleanup = await rm(cwd, { recursive: true, force: true }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (failure) throw failure;
  if (cleanup) throw cleanup;
  return { code: child.exitCode, stdout, stderr };
}
