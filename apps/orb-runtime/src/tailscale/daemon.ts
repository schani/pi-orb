import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { TailscaleEnv } from "./env.ts";

/**
 * Tier-1 port exposure (docs/ports.md): tailscaled in userspace-networking
 * mode, which needs neither a TUN device nor NET_ADMIN — the runtime
 * container has neither. Inbound tailnet connections are forwarded to the
 * same port on 127.0.0.1, so any server the agent starts is reachable.
 *
 * The whole feature is best-effort. Every failure mode here is reported as a
 * typed error to the caller, which logs it and boots anyway; a missing
 * binary, a rejected auth key, or a crashed daemon must never make an orb
 * unhealthy.
 */

/** tailscaled's default socket path; the CLI is pointed at it explicitly. */
const SOCKET_PATH = "/var/run/tailscale/tailscaled.sock";

const UP_ATTEMPTS = 3;
const UP_RETRY_DELAY_MS = 2_000;
/** `tailscale up` waits for the Running state itself; this bounds the wait. */
const UP_TIMEOUT = "60s";
const UP_KILL_MS = 90_000;

export interface TailscaleFailure {
  readonly code: "state_dir_failed" | "daemon_spawn_failed" | "daemon_exited" | "up_failed";
  readonly message: string;
}

/**
 * Node identity and keys must survive container replacement, so the state
 * dir lives on the persistent `/workspace` volume. `.pi-orb/` cannot collide
 * with the checkout (`<workDir>/repo`), the clone staging dir
 * (`<workDir>/.clone-tmp`, removed and renamed wholesale on every fresh
 * clone), or the Pi directories next to them.
 */
export function tailscaleStateDir(workDir: string): string {
  return join(workDir, ".pi-orb", "tailscale");
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Child-process failures quote the command line, which carries the key. */
const redact = (text: string, secret: string): string =>
  secret === "" ? text : text.split(secret).join("<redacted>");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const makeDir = (path: string, mode: number): ResultAsync<void, string> =>
  ResultAsync.fromPromise(mkdir(path, { recursive: true, mode }), message).map(() => undefined);

const logLines = (prefix: string, chunk: unknown): void => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim() !== "") console.log(`${prefix} ${line}`);
  }
};

/**
 * Spawns tailscaled and hands back a liveness probe. The child is fully
 * insulated: `error` and `exit` are always subscribed, so neither can reach
 * the process as an unhandled event.
 */
function spawnDaemon(stateDir: string): Result<() => string | null, string> {
  return Result.fromThrowable(
    () =>
      spawn(
        "tailscaled",
        ["--tun=userspace-networking", `--statedir=${stateDir}`, `--socket=${SOCKET_PATH}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    message,
  )().map((child) => {
    let dead: string | null = null;
    child.stdout?.on("data", (chunk: unknown) => logLines("tailscaled:", chunk));
    child.stderr?.on("data", (chunk: unknown) => logLines("tailscaled:", chunk));
    child.on("error", (error) => {
      dead = message(error);
      console.error(`tailscale: tailscaled failed: ${dead}`);
    });
    child.on("exit", (code, signal) => {
      dead = `exited with ${signal ?? `code ${code ?? "unknown"}`}`;
      // No restart loop: port exposure stays down until the orb is replaced,
      // which is strictly better than fighting a daemon that cannot run.
      console.error(`tailscale: tailscaled ${dead}; port exposure is unavailable`);
    });
    return () => dead;
  });
}

const runUp = (config: TailscaleEnv): ResultAsync<void, string> =>
  ResultAsync.fromPromise(
    new Promise<void>((resolve, reject) => {
      execFile(
        "tailscale",
        [
          `--socket=${SOCKET_PATH}`,
          "up",
          `--authkey=${config.authKey}`,
          `--hostname=${config.hostname}`,
          // MagicDNS resolution from inside the orb is not needed, and
          // letting tailscaled rewrite /etc/resolv.conf would risk the
          // container's own DNS (git, npm, the control plane).
          "--accept-dns=false",
          `--timeout=${UP_TIMEOUT}`,
        ],
        { timeout: UP_KILL_MS },
        (error, _stdout, stderr) => {
          if (error !== null) reject(new Error(stderr.trim() || error.message));
          else resolve();
        },
      );
    }),
    (error) => redact(message(error), config.authKey),
  );

export interface StartTailscaleOptions {
  readonly config: TailscaleEnv;
  /** Persistent orb filesystem root; the state dir is derived from it. */
  readonly workDir: string;
}

/**
 * Joins the tailnet. Resolves with a typed failure instead of rejecting, in
 * every case — the caller boots the orb regardless of the outcome.
 */
export async function startTailscale(
  options: StartTailscaleOptions,
): Promise<Result<void, TailscaleFailure>> {
  const { config, workDir } = options;
  const stateDir = tailscaleStateDir(workDir);

  const dirs = await makeDir(stateDir, 0o700).andThen(() =>
    // tailscaled creates the socket but not its directory.
    makeDir(dirname(SOCKET_PATH), 0o755),
  );
  if (dirs.isErr()) return err({ code: "state_dir_failed", message: dirs.error });

  const daemon = spawnDaemon(stateDir);
  if (daemon.isErr()) return err({ code: "daemon_spawn_failed", message: daemon.error });
  const deadReason = daemon.value;

  // tailscaled needs a moment to create the socket; `tailscale up` polls for
  // the Running state itself, so retries only cover that startup window.
  let lastError = "no attempt was made";
  for (let attempt = 1; attempt <= UP_ATTEMPTS; attempt += 1) {
    const exited = deadReason();
    if (exited !== null) return err({ code: "daemon_exited", message: exited });
    const up = await runUp(config);
    if (up.isOk()) return ok(undefined);
    lastError = up.error;
    console.error(`tailscale: up attempt ${attempt}/${UP_ATTEMPTS} failed: ${lastError}`);
    if (attempt < UP_ATTEMPTS) await delay(UP_RETRY_DELAY_MS * attempt);
  }
  return err({ code: "up_failed", message: lastError });
}
