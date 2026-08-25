import { join } from "node:path";
import { readMockOpenAiEnv } from "@pi-orb/mock-openai";
import { readBrokerEnv } from "./broker/endpoint.ts";
import { ORB_MARKER_ENV } from "./hooks/runner.ts";
import { buildRuntimeServer } from "./http/server.ts";
import { PiOrbAgent } from "./pi/agent.ts";
import { startTailscale } from "./tailscale/daemon.ts";
import { readTailscaleEnv } from "./tailscale/env.ts";
import { TerminalManager } from "./terminal/manager.ts";
import { checkTestLaunchFailure } from "./test-launch-failure.ts";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  console.error(`missing required environment variable ${name}`);
  process.exit(1);
};

/** `startTailscale` resolves with a typed failure; a rejection is a bug. */
const unreachableRejection = (error: unknown): void => {
  console.error("tailscale: unexpected rejection:", error);
};

async function main(): Promise<void> {
  const workDir = env("PI_ORB_WORK_DIR", "/workspace");
  // Every process in the orb — hooks, the agent's shells, terminals — sees
  // this, the analogue of Amp's `AMP_ORB=1` (docs/orb-setup-hook.md). `AMP_ORB`
  // is deliberately never set: a script's Amp-only branch must not run here.
  process.env[ORB_MARKER_ENV] = "1";
  const launchFailure = checkTestLaunchFailure(process.env, workDir);
  if (launchFailure.error !== undefined) console.error(launchFailure.error);
  if (launchFailure.inject) {
    console.error(
      `test launch failure injected for orb=${env("PI_ORB_ID")} incarnation=${env("PI_ORB_HOST_INCARNATION")}`,
    );
  }
  const tailscale = readTailscaleEnv(process.env);
  const agent = new PiOrbAgent({
    orbId: env("PI_ORB_ID"),
    repositoryUrl: env("PI_ORB_REPOSITORY_URL"),
    workDir,
    broker: readBrokerEnv(process.env),
    mockOpenAi: readMockOpenAiEnv(process.env),
    previewHost: tailscale?.previewHost ?? null,
    incarnation: env("PI_ORB_HOST_INCARNATION", "0"),
    testLaunchFailure: launchFailure.inject,
  });

  // The health server starts before slow initialization (docs/host-provider.md).
  // PTYs are admitted only after the checkout is ready, but their manager is
  // installed now so Fastify owns cleanup on every shutdown path.
  const terminalManager = new TerminalManager({ cwd: join(workDir, "repo") });
  const app = buildRuntimeServer(agent, terminalManager);
  const configuredPort = Number(env("PI_ORB_RUNTIME_PORT", "8080"));
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    console.error("PI_ORB_RUNTIME_PORT must be an integer from 1 through 65535");
    process.exit(1);
  }
  // Closing Fastify also closes every terminal PTY. Process-backed test hosts
  // use IPC disconnect; Docker/GCE and explicit local stops use TERM/INT.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A resume hook still running past its blocking window stops with the orb.
    agent.shutdownHooks();
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`shutdown after ${reason} failed:`, error);
        process.exit(1);
      },
    );
  };
  process.on("disconnect", () => shutdown("supervisor disconnect"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  const listening = await app.listen({ port: configuredPort, host: "0.0.0.0" }).then(
    (address) => address,
    (error: unknown) => {
      console.error("listen failed:", error);
      // The runtime cannot restart itself; exit so the host supervisor does.
      process.exit(1);
    },
  );
  console.log(`orb runtime listening on ${listening}`);

  // Tier-1 port exposure (docs/ports.md) is optional and never blocks the
  // boot: joining the tailnet runs alongside it and only ever logs.
  if (tailscale !== null) {
    void startTailscale({ config: tailscale, workDir }).then((result) => {
      if (result.isErr()) {
        console.error(
          `tailscale: port exposure unavailable (${result.error.code}): ${result.error.message}`,
        );
        return;
      }
      console.log(`tailscale: ports are reachable at http://${tailscale.previewHost}:<port>`);
    }, unreachableRejection);
  }

  await agent.boot();
  const health = agent.getHealth();
  if (health.status === "failed") {
    // Stay reachable long enough for the control plane to record the typed
    // error (docs/host-provider.md); supervision handles unexpected exits.
    console.error(`initialization failed: ${health.error.code}: ${health.error.message}`);
    return;
  }
  console.log("orb runtime ready");
}

void main();
