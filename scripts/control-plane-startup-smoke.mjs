import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { STARTUP_PHASES } from "../apps/control-plane/src/startup.ts";

export const EXPECTED_PHASES = STARTUP_PHASES;
export const HEALTH_PROBE = (timeout) => `
fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(${timeout}) })
  .then(async (response) => {
    if (response.status !== 200 || (await response.json()).status !== "ok") process.exitCode = 1;
  })
  .catch(() => { process.exitCode = 1; });
`;

const DEADLINE_MS = 60_000;
const COMMAND_MS = 5_000;

/** Docker, clock and sleep are injected so deadline/cleanup tests own the schedule. */
export async function runStartupSmoke({ docker, now, sleep, signal }, image, name) {
  const deadline = now() + DEADLINE_MS;
  const controller = new AbortController();
  const cancel = () => controller.abort({ code: "cancelled" });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort({ code: "deadline" }), DEADLINE_MS);
  const ownership = randomUUID();
  let container;
  let createAttempted = false;
  let logs = "";
  const interrupted = () =>
    controller.signal.aborted
      ? controller.signal.reason
      : now() >= deadline
        ? { code: "deadline" }
        : null;
  const run = async (args) => {
    const stop = interrupted();
    if (stop) return err(stop);
    const result = await docker(
      args,
      Math.max(
        1,
        Math.floor(args[0] === "exec" ? Math.min(COMMAND_MS, deadline - now()) : deadline - now()),
      ),
      controller.signal,
    );
    return interrupted() ? err(interrupted()) : result;
  };
  const boot = async () => {
    if (interrupted()) return err(interrupted());
    createAttempted = true;
    const created = await run([
      "create",
      "--pull=never",
      "--name",
      name,
      "--label",
      `pi-orb.startup-smoke=${ownership}`,
      "--network",
      "none",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m",
      "-e",
      "HOME=/tmp/startup-smoke",
      "-e",
      "PORT=8080",
      "-e",
      "PI_ORB_AUTH_MODE=local",
      "-e",
      "PI_ORB_DATABASE_KIND=pglite",
      "-e",
      "PI_ORB_PGLITE_PATH=/tmp/startup-smoke/database",
      "-e",
      "PI_ORB_AUTH_DIR=/tmp/startup-smoke/auth",
      "-e",
      "PI_ORB_SECRET_STORE=file",
      "-e",
      "PI_ORB_HOST_PROVIDER=process",
      "-e",
      "PI_ORB_PROCESS_STATE_DIR=/tmp/startup-smoke/hosts",
      image,
    ]);
    if (created.isErr()) return created;
    const cid = created.value.trim();
    if (!/^[a-f0-9]{64}$/.test(cid)) return err({ code: "invalid_container_id" });
    container = cid;
    const started = await run(["start", container]);
    if (started.isErr()) return started;
    while (now() < deadline) {
      const health = await run([
        "exec",
        container,
        "node",
        "--input-type=module",
        "-e",
        HEALTH_PROBE(Math.max(1, Math.floor(Math.min(4000, deadline - now())))),
      ]);
      if (interrupted()) return err(interrupted());
      if (health.isOk()) return ok(undefined);
      const state = await run(["inspect", "--format", "{{.State.Running}}", container]);
      if (state.isErr()) return state;
      if (state.value.trim() !== "true") return err({ code: "container_stopped" });
      await sleep(Math.min(1000, Math.max(0, deadline - now())), controller.signal);
    }
    return err(interrupted() ?? { code: "deadline" });
  };

  let result;
  let cleanup = ok(undefined);
  let recoveryError;
  try {
    result = await boot();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    // A timed-out create can have succeeded. A name alone never proves ownership.
    if (!container && createAttempted) {
      const recoveryDeadline = now() + COMMAND_MS;
      while (now() < recoveryDeadline) {
        const inspected = await docker(
          ["inspect", name],
          Math.max(1, Math.floor(recoveryDeadline - now())),
        );
        if (inspected.isOk()) {
          const parsed = Result.fromThrowable(
            () => JSON.parse(inspected.value),
            () => null,
          )();
          const candidate = parsed.isOk() ? parsed.value?.[0] : undefined;
          if (
            /^[a-f0-9]{64}$/.test(candidate?.Id ?? "") &&
            candidate?.Config?.Image === image &&
            candidate?.Config?.Labels?.["pi-orb.startup-smoke"] === ownership
          ) {
            container = candidate.Id;
            recoveryError = undefined;
          } else recoveryError = "ownership_not_verified";
          break;
        }
        recoveryError = "ownership_inspect_failed";
        // The daemon can finish creating after the CLI was killed and the first inspect failed.
        await sleep(Math.min(100, Math.max(0, recoveryDeadline - now())));
      }
    }
    if (container) {
      // Evidence and teardown have separate bounds, independent of cancellation/deadline.
      const captured = await docker(["logs", container], COMMAND_MS);
      if (captured.isOk()) logs = captured.value;
      else if (result?.isOk()) result = captured;
      cleanup = await docker(["rm", "-f", container], COMMAND_MS);
    }
  }
  if (cleanup.isErr()) return err({ code: "cleanup_failed", container, logs });
  if (result.isErr())
    return err({
      ...result.error,
      ...(recoveryError ? { recovery: recoveryError, name, ownership, image } : {}),
      logs,
    });
  const parsed = Result.fromThrowable(
    () =>
      logs
        .split("\n")
        .filter((line) => line.startsWith('{"event":"control-plane-startup",'))
        .map((line) => JSON.parse(line)),
    () => ({ code: "invalid_phase_json", logs }),
  )();
  if (parsed.isErr()) return parsed;
  const marks = parsed.value;
  if (
    marks.length !== EXPECTED_PHASES.length ||
    marks.some(
      (mark, index) =>
        mark.phase !== EXPECTED_PHASES[index] ||
        !Number.isSafeInteger(mark.elapsed_ms) ||
        mark.elapsed_ms < 0 ||
        (index > 0 && mark.elapsed_ms < marks[index - 1].elapsed_ms),
    )
  )
    return err({ code: "phase_order", logs });
  return ok({ logs, phases: marks.length });
}

function docker(args, timeout, signal) {
  return new Promise((resolve) => {
    let child;
    // Node 26 execFile does not forward killSignal to its AbortSignal handler.
    const cancel = () =>
      Result.fromThrowable(
        () => child.kill("SIGKILL"),
        () => ({ code: "docker_kill", operation: args[0] }),
      )();
    const spawned = Result.fromThrowable(
      () =>
        execFile(
          "docker",
          args,
          {
            encoding: "utf8",
            timeout,
            killSignal: "SIGKILL",
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            signal?.removeEventListener("abort", cancel);
            resolve(
              error
                ? err({
                    code: "docker",
                    operation: args[0],
                    status: error.code,
                    signal: error.signal,
                  })
                : ok(stdout + (args[0] === "logs" ? stderr : "")),
            );
          },
        ),
      () => ({ code: "docker_spawn", operation: args[0] }),
    )();
    if (spawned.isErr()) resolve(spawned);
    else {
      child = spawned.value;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const image = process.argv[2];
  if (!image) {
    console.error("Usage: node scripts/control-plane-startup-smoke.mjs IMAGE");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    const result = await runStartupSmoke(
      {
        docker,
        now: () => performance.now(),
        signal: controller.signal,
        sleep: (ms, signal) =>
          ResultAsync.fromPromise(delay(ms, undefined, { signal }), () => ({ code: "cancelled" })),
      },
      image,
      `cp-startup-${randomUUID()}`,
    );
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
    console.log(result.isOk() ? result.value.logs : (result.error.logs ?? ""));
    console.log(
      JSON.stringify(
        result.isOk()
          ? { status: "PASS", phases: result.value.phases }
          : { status: "FAIL", failure: { ...result.error, logs: undefined } },
      ),
    );
    if (result.isErr()) process.exitCode = 1;
  }
}
