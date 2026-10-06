import { join } from "node:path";
import websocket from "@fastify/websocket";
import { ResultAsync } from "neverthrow";
import { readBrokerEnv } from "../broker/endpoint.ts";
import { ORB_MARKER_ENV } from "../hooks/env-file.ts";
import { registerTerminalRoute } from "../http/terminal-route.ts";
import { startTailscale } from "../tailscale/daemon.ts";
import { readTailscaleEnv } from "../tailscale/env.ts";
import { TerminalManager } from "../terminal/manager.ts";
import { registerUploadRoutes } from "../uploads/routes.ts";
import { forwardExecutionAlert } from "./alert-forwarder.ts";
import { ExecutionBoot } from "./boot.ts";
import { buildExecutionServer } from "./server.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (value) return value;
  console.error(`execution host missing ${name}`);
  process.exit(1);
};
const workDir = env("PI_ORB_WORK_DIR");
const incarnation = env("PI_ORB_HOST_INCARNATION");
const controlPlaneUrl = env("PI_ORB_CONTROL_PLANE_URL");
const token = env("PI_ORB_RUNTIME_TOKEN");
process.env[ORB_MARKER_ENV] = "1";
const boot = new ExecutionBoot({
  workDir,
  incarnation,
  orbId: env("PI_ORB_ID"),
  repositoryUrl: env("PI_ORB_REPOSITORY_URL"),
  skillsDir: process.env.PI_ORB_SKILLS_DIR ?? "",
  environment: process.env,
  broker: readBrokerEnv(process.env),
});
const app = buildExecutionServer({
  token,
  appendAlert: (input) => forwardExecutionAlert({ controlPlaneUrl, token, incarnation }, input),
  incarnation,
  cwd: join(workDir, "repo"),
  ready: () => boot.snapshot,
  health: () => boot.health(),
});
const terminals = new TerminalManager({ cwd: join(workDir, "repo") });
await app.register(websocket);
registerTerminalRoute(app, { manager: terminals, isReady: () => boot.snapshot !== null });
await registerUploadRoutes(app, { workDir, incarnation, ready: () => boot.snapshot !== null });
app.addHook("onClose", async () => {
  boot.shutdown();
  terminals.closeAll();
});
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  boot.shutdown();
  void ResultAsync.fromPromise(app.close(), () => "execution shutdown failed").then((result) => {
    if (result.isErr()) console.error(result.error);
    process.exit(result.isErr() ? 1 : 0);
  });
};
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
const listening = await ResultAsync.fromPromise(
  app.listen({ port: Number(process.env.PI_ORB_RUNTIME_PORT ?? "8080"), host: "0.0.0.0" }),
  () => "execution listen failed",
);
if (listening.isErr()) {
  console.error(listening.error);
  process.exit(1);
}
const tailscale = readTailscaleEnv(process.env);
if (tailscale !== null) {
  void startTailscale({ config: tailscale, workDir }).then(
    (result) => {
      if (result.isErr())
        console.error(
          `tailscale: port exposure unavailable (${result.error.code}): ${result.error.message}`,
        );
    },
    () => console.error("tailscale: unexpected adapter rejection"),
  );
}
const result = await boot.boot();
if (result.isErr()) console.error(`execution boot failed: ${result.error.code}`);
