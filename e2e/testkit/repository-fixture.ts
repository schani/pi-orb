import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The repository E2E orbs use; cloning it from GitHub made boot depend on GitHub throughput. */
export const REPOSITORY_FIXTURE_URL = "https://github.com/schani/pi-orb";

export interface RepositoryFixture {
  /** Reachable from the control plane and process hosts. */
  readonly hostUrl: string;
  /** Reachable from Docker runtimes through the host gateway. */
  readonly containerUrl: string;
  readonly commit: string;
}

/** Git config environment that redirects the GitHub repository to `target`. */
export function repositoryRewrite(target: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${target}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPOSITORY_FIXTURE_URL,
  };
}

let started: Promise<RepositoryFixture> | undefined;
let cleanup: (() => void | Promise<void>) | undefined;

export async function stopRepositoryFixture(): Promise<void> {
  await cleanup?.();
  cleanup = undefined;
  started = undefined;
}

/** One-commit snapshot of this checkout served by `git daemon`, shared by the test file. */
export function repositoryFixture(): Promise<RepositoryFixture> {
  started ??= start();
  return started;
}

async function start(): Promise<RepositoryFixture> {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-repository-fixture-"));
  cleanup = () => rmSync(root, { recursive: true, force: true });
  const repository = join(root, "pi-orb");
  mkdirSync(repository);
  const git = (args: string[], input?: Buffer) =>
    execFileSync("git", args, { input, maxBuffer: 1 << 30 })
      .toString()
      .trim();
  git(["init", "-q", "-b", "main", repository]);
  const snapshot = execFileSync(
    "git",
    ["-C", resolve(import.meta.dirname, "../.."), "archive", "HEAD"],
    {
      maxBuffer: 1 << 30,
    },
  );
  execFileSync("tar", ["-x", "-C", repository], { input: snapshot });
  git(["-C", repository, "add", "-A"]);
  git([
    "-C",
    repository,
    "-c",
    "user.name=pi-orb",
    "-c",
    "user.email=pi-orb@localhost",
    "commit",
    "-q",
    "-m",
    "E2E repository fixture",
  ]);
  const commit = git(["-C", repository, "rev-parse", "HEAD"]);
  const port = await freePort();
  // Docker runtimes reach the host gateway, so the daemon cannot bind loopback only.
  const daemon = spawn(
    "git",
    ["daemon", "--reuseaddr", "--export-all", `--base-path=${root}`, `--port=${port}`, root],
    { stdio: "ignore" },
  );
  cleanup = async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  };
  const hostUrl = `git://127.0.0.1:${port}/pi-orb`;
  for (let attempt = 0; spawnSync("git", ["ls-remote", hostUrl]).status !== 0; attempt++) {
    if (attempt >= 50) throw new Error("repository fixture daemon did not start");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return { hostUrl, containerUrl: `git://host.docker.internal:${port}/pi-orb`, commit };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no free port")),
      );
    });
  });
}
