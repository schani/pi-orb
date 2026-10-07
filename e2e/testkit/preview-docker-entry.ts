import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { OrbAgent } from "../../apps/orb-runtime/src/domain/orb-agent.ts";
import { RuntimePreviewService } from "../../apps/orb-runtime/src/domain/preview.ts";
import { PreviewActivity } from "../../apps/orb-runtime/src/domain/preview-activity.ts";
import { registerPreviewRoutes } from "../../apps/orb-runtime/src/http/preview-route.ts";
import { HmacPreviewVerifier } from "../../apps/orb-runtime/src/preview/admission.ts";
import { startPreviewApplication } from "./preview-application.ts";
import { startPreviewSocketBridge } from "./preview-socket-bridge.ts";
import { startPreviewViteApplication } from "./preview-vite-application.ts";

// These imports resolve to /app's image-baked runtime, not the host's source checkout.
const orbId = process.env["PREVIEW_FIXTURE_ORB"];
const token = process.env["PREVIEW_FIXTURE_TOKEN"];
const runtimeInstanceId = randomUUID();
const executionId = randomUUID();
if (!orbId || !token) throw new Error("Owned fixture identity missing");
const application = await startPreviewApplication(3000);
const wrong = await startPreviewApplication(3001);
const vite = await startPreviewViteApplication(3002);
const health = {
  v: 1 as const,
  status: "ready" as const,
  orbId,
  incarnation: 0,
  executionId,
  runtimeInstanceId,
  sessionId: "test-session",
  checkoutCommit: "test-commit",
  activity: "idle" as const,
};
const activity = new PreviewActivity();
const agent = {
  previewActivity: activity,
  runtimeInstanceId,
  getHealth: () => health,
  gateView: () => ({ acceptingWork: true }),
} as unknown as OrbAgent;
const app = Fastify();
await app.register(websocket);
const service = new RuntimePreviewService({
  agent,
  orbId,
  verifier: new HmacPreviewVerifier(token),
  reservedPorts: () => [8080, 8081],
});
app.get("/v1/health", () => health);
app.get("/__fixture/info", () => ({
  ports: [application.port, wrong.port, vite.port],
  requests: application.requests,
  wrongRequests: wrong.requests.length,
  frames: application.frames,
  active: activity.blocksIdle(),
  runtimeInstanceId,
  executionId,
}));
app.post("/__fixture/binary", () => {
  application.finishBinary();
  return { ok: true };
});
app.post<{ Body: { data: string } }>("/__fixture/event", (request) => {
  application.sendEvent(request.body.data);
  return { ok: true };
});
app.post<{ Body: { value: string } }>("/__fixture/vite", async (request) => {
  await vite.update(request.body.value);
  return { ok: true };
});
await app.register(async (scope) => registerPreviewRoutes(scope, service));
if (process.env["PREVIEW_FIXTURE_UNIX"] === "1") {
  await startPreviewSocketBridge("/fixture/broker.sock", 8081);
  await rm("/fixture/runtime.sock", { force: true });
  await app.listen({ path: "/fixture/runtime.sock" });
  // The host UID differs from container root; the enclosing host-owned directory is mode 0700.
  await chmod("/fixture/runtime.sock", 0o666);
} else {
  await app.listen({ port: 8080, host: "0.0.0.0" });
}
process.stdout.write("preview-fixture-ready\n");
