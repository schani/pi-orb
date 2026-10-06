import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  type ResourceError,
  type ResourceSnapshot,
  type ResourceSource,
  resourceError,
} from "../../domain/resources.ts";
import { snapshotPromptResources } from "./prompt.ts";
import { collectResources, type TreeEntry } from "./selection.ts";

export interface GitCredentials {
  environment(
    url: string,
    signal: AbortSignal,
    orbId: string,
  ): ResultAsync<Record<string, string>, ResourceError>;
}
/** Executes only Git in a fresh bare repository. No checkout, repository config or hook execution. */
export function command(
  args: string[],
  cwd: string,
  environment: Record<string, string>,
  signal: AbortSignal,
  input?: string,
  inspectPack?: () => ResultAsync<number, ResourceError>,
): ResultAsync<Buffer, ResourceError> {
  const stage = ["init", "fetch", "rev-parse", "ls-tree", "cat-file"].includes(args[0] ?? "")
    ? args[0]
    : "unknown";
  const promise = new Promise<Result<Buffer, ResourceError>>((resolve) => {
    const spawned = Result.fromThrowable(
      () =>
        spawn(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "-c",
            "fetch.unpackLimit=1",
            "-c",
            "transfer.unpackLimit=1",
            ...args,
          ],
          {
            cwd,
            env: {
              PATH: process.env.PATH,
              ...environment,
              HOME: cwd,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              GIT_NO_LAZY_FETCH: "1",
            },
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
      () => resourceError("fetch", `Git resource operation failed (${stage}; spawn)`),
    )();
    if (spawned.isErr()) {
      resolve(err(spawned.error));
      return;
    }
    const child = spawned.value;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let failure: ResourceError | undefined;
    let closed = false;
    let killed = false;
    let monitor: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (killed || closed) return;
      killed = true;
      // The detached child owns this group; never signal the host's process group.
      Result.fromThrowable(
        () => {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        },
        () => undefined,
      )();
      // close acknowledges stdio drainage. Bound drainage even if a helper escaped the group.
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }, 5000);
      drain.unref();
    };
    const abort = () => {
      failure = resourceError("cancelled", `Resource acquisition cancelled (${stage})`);
      terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        failure = resourceError("limit", `Git output limit exceeded (${stage})`);
        terminate();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => {
      failure ??= resourceError("fetch", `Git resource operation failed (${stage}; spawn)`);
      terminate();
    });
    let checking: Promise<void> | undefined;
    const check = async () => {
      if (closed || killed || !inspectPack) return;
      const inspected = await inspectPack();
      if (closed || killed) return;
      if (inspected.isErr() || inspected.value > 128 * 1024 * 1024) {
        failure = inspected.isErr()
          ? inspected.error
          : resourceError("limit", `Resource Git pack limit exceeded (${stage})`);
        terminate();
      } else
        monitor = setTimeout(() => {
          checking = check();
        }, 100);
    };
    child.on("close", (code, exitSignal) => {
      closed = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(monitor);
      clearTimeout(drain);
      const finish = async () => {
        await checking;
        resolve(
          failure
            ? err(failure)
            : code !== 0
              ? err(
                  resourceError(
                    "fetch",
                    `Git resource operation failed (${stage}; ${exitSignal ? `signal=${exitSignal}` : `exit=${code}`})`,
                  ),
                )
              : ok(Buffer.concat(chunks)),
        );
      };
      void finish();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    if (inspectPack) checking = check();
  });
  return ResultAsync.fromPromise(promise, () =>
    resourceError("fetch", `Git resource operation failed (${stage}; adapter)`),
  ).andThen((result) => result);
}
export class GitResourceSource implements ResourceSource {
  private readonly credentials: GitCredentials;
  private readonly allowLocal: boolean;
  constructor(credentials: GitCredentials, allowLocal = false) {
    this.credentials = credentials;
    this.allowLocal = allowLocal;
  }
  acquire(input: {
    orbId: string;
    url: string;
    signal: AbortSignal;
  }): ResultAsync<ResourceSnapshot, ResourceError> {
    const callerSignal = input.signal;
    const deadline = AbortSignal.timeout(180_000);
    input = { ...input, signal: AbortSignal.any([callerSignal, deadline]) };
    const run = async () => {
      const parsed = (() => {
        try {
          return new URL(input.url);
        } catch {
          return null;
        }
      })();
      if (
        !parsed ||
        parsed.username ||
        parsed.password ||
        !(parsed.protocol === "https:" || (this.allowLocal && parsed.protocol === "file:"))
      )
        return err(resourceError("invalid", "Unsupported resource repository URL"));
      if (input.signal.aborted)
        return err(resourceError("cancelled", "Resource acquisition cancelled"));
      const auth = await this.credentials.environment(input.url, input.signal, input.orbId);
      if (auth.isErr()) return err(auth.error);
      const temp = await ResultAsync.fromPromise(mkdtemp(join(tmpdir(), "pi-orb-resources-")), () =>
        resourceError("fetch", "Resource staging unavailable"),
      );
      if (temp.isErr()) return err(temp.error);
      const inspectPack = () => {
        const dir = join(temp.value, "objects", "pack");
        const inspect = async () => {
          const listed = await ResultAsync.fromPromise(readdir(dir), (error) => error);
          if (listed.isErr()) {
            return typeof listed.error === "object" &&
              listed.error !== null &&
              "code" in listed.error &&
              listed.error.code === "ENOENT"
              ? ok(0)
              : err(resourceError("fetch", "Resource pack inspection failed (fetch)"));
          }
          let total = 0;
          for (const file of listed.value) {
            const inspected = await ResultAsync.fromPromise(
              stat(join(dir, file)),
              (error) => error,
            );
            // Git renames incoming pack files while the monitor is running.
            if (inspected.isErr()) {
              if (
                typeof inspected.error === "object" &&
                inspected.error !== null &&
                "code" in inspected.error &&
                inspected.error.code === "ENOENT"
              )
                continue;
              return err(resourceError("fetch", "Resource pack inspection failed (fetch)"));
            }
            total += inspected.value.size;
          }
          return ok(total);
        };
        return ResultAsync.fromPromise(inspect(), () =>
          resourceError("fetch", "Resource pack inspection failed (fetch)"),
        ).andThen((result) => result);
      };
      const git = (args: string[], data?: string) =>
        command(
          args,
          temp.value,
          auth.value,
          input.signal,
          data,
          args[0] === "fetch" ? inspectPack : undefined,
        ).andThen((bytes) =>
          args[0] !== "fetch"
            ? ok(bytes)
            : inspectPack().andThen((total) =>
                total > 128 * 1024 * 1024
                  ? err(resourceError("limit", "Resource Git pack limit exceeded (fetch)"))
                  : ok(bytes),
              ),
        );
      const acquire = async () => {
        const init = await git(["init", "--bare", "."]);
        if (init.isErr()) return err(init.error);
        const fetch = await git([
          "fetch",
          "--depth=1",
          "--filter=blob:none",
          "--no-tags",
          "--no-write-fetch-head",
          input.url,
          "refs/heads/main:refs/resources/target",
        ]);
        if (fetch.isErr()) return err(fetch.error);
        const sha = await git(["rev-parse", "--verify", "refs/resources/target^{commit}"]);
        if (sha.isErr()) return err(sha.error);
        const commitSha = sha.value.toString("utf8").trim();
        if (!/^[a-f0-9]{40}$/.test(commitSha))
          return err(resourceError("invalid", "Invalid repository commit"));
        const listed = await git(["ls-tree", "-r", "-t", "-z", commitSha]);
        if (listed.isErr()) return err(listed.error);
        const entries: TreeEntry[] = [];
        for (const row of listed.value.toString("utf8").split("\0")) {
          if (!row) continue;
          const match = /^(\d+) \w+ ([a-f0-9]+)\t(.+)$/.exec(row);
          if (!match || !match[1] || !match[2] || !match[3])
            return err(resourceError("invalid", "Invalid repository tree"));
          entries.push({ mode: match[1], oid: match[2], path: match[3] });
        }
        const selection = await collectResources(entries, (oids) => {
          const read = async () => {
            const fetched = await git(
              [
                "fetch",
                "--refetch",
                "--no-filter",
                "--no-tags",
                "--no-write-fetch-head",
                "--stdin",
                input.url,
              ],
              oids.join("\n") + "\n",
            );
            if (fetched.isErr()) return err(fetched.error);
            const batch = await git(["cat-file", "--batch"], oids.join("\n") + "\n");
            if (batch.isErr()) return err(batch.error);
            const result = new Map<string, Uint8Array>();
            let offset = 0;
            for (const oid of oids) {
              const newline = batch.value.indexOf(10, offset);
              if (newline < 0) return err(resourceError("fetch", "Invalid resource blob batch"));
              const header = batch.value.subarray(offset, newline).toString("ascii");
              const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
              if (!match || match[1] !== oid || !match[2])
                return err(resourceError("fetch", "Required resource blob unavailable"));
              const size = Number(match[2]);
              offset = newline + 1;
              if (
                !Number.isSafeInteger(size) ||
                size < 0 ||
                offset + size >= batch.value.length ||
                batch.value[offset + size] !== 10
              )
                return err(resourceError("fetch", "Invalid resource blob size"));
              const bytes = batch.value.subarray(offset, offset + size);
              if (createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex") !== oid)
                return err(resourceError("fetch", "Resource blob integrity check failed"));
              result.set(oid, bytes);
              offset += size + 1;
            }
            if (offset !== batch.value.length)
              return err(resourceError("fetch", "Invalid resource blob batch trailer"));
            return ok(result);
          };
          return ResultAsync.fromPromise(read(), () =>
            resourceError("fetch", "Resource blob acquisition failed"),
          ).andThen((r) => r);
        });
        return selection.andThen((value) => {
          const snapshot = { orbId: input.orbId, commitSha, ...value };
          return snapshotPromptResources(snapshot).map(() => snapshot);
        });
      };
      const result = await ResultAsync.fromPromise(acquire(), () =>
        resourceError("fetch", "Resource acquisition failed"),
      ).andThen((result) => result);
      const cleanup = await ResultAsync.fromPromise(
        rm(temp.value, { recursive: true, force: true }),
        () => resourceError("fetch", "Resource staging cleanup failed"),
      );
      return cleanup.isErr() ? err(cleanup.error) : result;
    };
    return ResultAsync.fromPromise(run(), () =>
      resourceError("fetch", "Resource acquisition failed"),
    )
      .andThen((r) =>
        input.signal.aborted
          ? err(
              resourceError(
                callerSignal.aborted ? "cancelled" : "limit",
                callerSignal.aborted
                  ? "Resource acquisition cancelled"
                  : "Resource acquisition deadline exceeded",
              ),
            )
          : r,
      )
      .mapErr((error) =>
        deadline.aborted && !callerSignal.aborted
          ? resourceError("limit", "Resource acquisition deadline exceeded")
          : error,
      );
  }
}
