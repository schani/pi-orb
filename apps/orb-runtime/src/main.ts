import { PiOrbAgent } from "./pi/agent.ts";
import { buildRuntimeServer } from "./http/server.ts";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  console.error(`missing required environment variable ${name}`);
  process.exit(1);
};

async function main(): Promise<void> {
  const agent = new PiOrbAgent({
    orbId: env("PI_ORB_ID"),
    repositoryUrl: env("PI_ORB_REPOSITORY_URL"),
    workDir: env("PI_ORB_WORK_DIR", "/workspace"),
    authDir: env("PI_ORB_AUTH_DIR", "/var/lib/pi-orb/auth"),
  });

  // The health server starts before slow initialization (DESIGN.md §5.1).
  const app = buildRuntimeServer(agent);
  const listening = await app.listen({ port: 8080, host: "0.0.0.0" }).then(
    (address) => address,
    (error: unknown) => {
      console.error("listen failed:", error);
      // The runtime cannot restart itself; exit so the host supervisor does.
      process.exit(1);
    },
  );
  console.log(`orb runtime listening on ${listening}`);

  await agent.boot();
  const health = agent.getHealth();
  if (health.status === "failed") {
    // Stay reachable long enough for the control plane to record the typed
    // error (DESIGN.md §5.1); supervision handles unexpected exits.
    console.error(`initialization failed: ${health.error.code}: ${health.error.message}`);
    return;
  }
  console.log("orb runtime ready");
}

void main();
