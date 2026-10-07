import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import websocket from "@fastify/websocket";
import { CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync, ResultAsync } from "neverthrow";
import { FetchRuntimeClient } from "../../apps/control-plane/src/adapters/runtime-client/fetch-client.ts";
import { NodePreviewClient } from "../../apps/control-plane/src/adapters/runtime-client/preview-client.ts";
import { requestOrbStart, requestOrbStop } from "../../apps/control-plane/src/domain/lifecycle.ts";
import { previewError } from "../../apps/control-plane/src/domain/preview.ts";
import { PreviewConnections } from "../../apps/control-plane/src/domain/preview-connections.ts";
import { registerPreviewGateway } from "../../apps/control-plane/src/http/preview-gateway.ts";
import { registerRuntimePreviewRoutes } from "../../apps/control-plane/src/http/runtime-preview-routes.ts";
import { makeHarness, seedRunningOrb } from "../../apps/control-plane/src/testkit/fixtures.ts";
import type { OrbAgent } from "../../apps/orb-runtime/src/domain/orb-agent.ts";
import { RuntimePreviewService } from "../../apps/orb-runtime/src/domain/preview.ts";
import { PreviewActivity } from "../../apps/orb-runtime/src/domain/preview-activity.ts";
import { registerPreviewRoutes } from "../../apps/orb-runtime/src/http/preview-route.ts";
import { HmacPreviewVerifier } from "../../apps/orb-runtime/src/preview/admission.ts";
import { startApplicationAuthFixture } from "./application-auth-fixture.ts";

/** Real HTTP/auth/forwarding adapters, in-memory authority and fake host inventory; not namespace isolation. */
export async function startPreviewComposition(
  ports: readonly number[],
  external?: {
    orbId: string;
    token: string;
    runtimeInstanceId?: string;
    baseUrl: string;
    cli?: (brokerPort: number, args: string[]) => Promise<string>;
    brokerSocket?: string;
  },
) {
  const task = new NoSimulationTask("preview composed integration", false);
  const orbId = external?.orbId ?? randomUUID();
  const token = external?.token ?? randomUUID();
  const h = makeHarness();
  seedRunningOrb(task, h, orbId);
  const seeded = h.store.orbSnapshot(orbId);
  if (!seeded) throw new Error("Seeded orb missing");
  h.store.seedOrb({
    ...seeded,
    runtimeTokenHash: createHash("sha256").update(token).digest("hex"),
  });
  const health = {
    v: 1 as const,
    status: "ready" as const,
    orbId,
    incarnation: seeded.hostIncarnation,
    executionId: "test-execution",
    runtimeInstanceId: external?.runtimeInstanceId ?? randomUUID(),
    sessionId: "test-session",
    checkoutCommit: "test-commit",
    activity: "idle" as const,
  };
  const activity = new PreviewActivity();
  const agent = {
    previewActivity: activity,
    runtimeInstanceId: health.runtimeInstanceId,
    getHealth: () => health,
    gateView: () => ({ acceptingWork: true }),
  } as unknown as OrbAgent;
  const runtime = external ? null : Fastify();
  const service = external
    ? null
    : new RuntimePreviewService({
        agent,
        orbId,
        verifier: new HmacPreviewVerifier(token),
        reservedPorts: () => [8080],
      });
  if (runtime && service) {
    await runtime.register(websocket);
    runtime.get("/v1/health", () => health);
    await runtime.register(async (scope) => registerPreviewRoutes(scope, service));
    await runtime.listen({ host: "127.0.0.1", port: 0 });
  }
  const baseUrl = external?.baseUrl ?? runtime?.listeningOrigin;
  if (!baseUrl) throw new Error("Runtime fixture origin missing");
  let observed = 0;
  h.deps.hostProvider.observe = () => {
    observed++;
    return okAsync({
      ref: { provider: "fake", resourceId: seeded.hostRef ?? "fixture" },
      orbId,
      incarnation: seeded.hostIncarnation,
      specFingerprint: seeded.hostSpecFingerprint ?? "fixture",
      state: "running",
      runtimeAddress: { baseUrl: external?.baseUrl ?? baseUrl },
    });
  };
  const deps = { ...h.deps, runtimeClient: new FetchRuntimeClient() };
  const connections = new PreviewConnections(deps, (_orb, operation) =>
    ResultAsync.fromPromise(operation(task), () =>
      previewError("cancelled", "Fixture watcher closed"),
    ),
  );
  const auth = await startApplicationAuthFixture({
    previews: true,
    orbId,
    previewPorts: ports,
    configurePreviews: async ({ app, hosts, appOrigin }) => {
      registerRuntimePreviewRoutes(app, task, {
        store: h.store,
        url: (id, port) => hosts.url(id, port),
        newId: randomUUID,
        reservedPort: 8080,
      });
      await registerPreviewGateway(app, task, {
        deps,
        hosts,
        appOrigin,
        connections,
        transport: new NodePreviewClient(),
      });
    },
  });
  // The CLI's broker seam changes only routing/TLS transport, not authorization or callbacks.
  const broker = createServer((request, response) => {
    if (!/^\/runtime\/previews(?:\/|$)/u.test(request.url ?? "")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const upstream = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: auth.applicationPort,
        path: request.url,
        method: request.method,
        rejectUnauthorized: false,
        headers: { ...request.headers, host: new URL(auth.appOrigin).host },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  if (external?.brokerSocket) broker.listen(external.brokerSocket);
  else broker.listen(0, external ? "0.0.0.0" : "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address) throw new Error("Broker fixture listener missing");
  const brokerPort = typeof address === "string" ? 0 : address.port;
  return {
    ...auth,
    h,
    task,
    orbId,
    activity,
    observed: () => observed,
    stopOrb: () => requestOrbStop(task, deps, orbId),
    startOrb: () => requestOrbStart(task, deps, orbId),
    cli: (args: string[]) =>
      external?.cli
        ? external.cli(brokerPort, args)
        : new Promise<string>((resolve, reject) => {
            execFile(
              process.execPath,
              ["apps/orb-runtime/src/previews/cli.ts", ...args],
              {
                timeout: 10_000,
                env: {
                  ...process.env,
                  [CONTROL_PLANE_URL_ENV]: `http://127.0.0.1:${brokerPort}`,
                  [RUNTIME_TOKEN_ENV]: token,
                },
              },
              (error, stdout, stderr) =>
                error
                  ? reject(new Error(`preview CLI: ${stderr}`, { cause: error }))
                  : resolve(stdout.trim()),
            );
          }),
    close: async () => {
      connections.close(task);
      service?.closeAll();
      await auth.close();
      await runtime?.close();
      broker.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        broker.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
