import { createHash, createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it } from "vitest";
import type { OrbAgent } from "../domain/orb-agent.ts";
import { RuntimePreviewService } from "../domain/preview.ts";
import { PreviewActivity } from "../domain/preview-activity.ts";
import { HmacPreviewVerifier } from "../preview/admission.ts";
import { registerPreviewRoutes } from "./preview-route.ts";

it("streams binary uploads, SSE first bytes before EOF and preserves app headers/path", async () => {
  let finish: (() => void) | undefined;
  let applicationHost: string | undefined;
  let forwardingHost: string | string[] | undefined;
  let forwardingProto: string | string[] | undefined;
  const upstream = createServer((req, res) => {
    applicationHost = req.headers.host;
    forwardingHost = req.headers["x-forwarded-host"];
    forwardingProto = req.headers["x-forwarded-proto"];
    expect(req.url).toBe("/nested/page?x=%2F");
    expect(req.headers.authorization).toBe("Bearer application");
    expect(req.headers.cookie).toBe("app=1");
    expect(req.headers["x-pi-orb-preview-admission"]).toBeUndefined();
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 12]));
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "set-cookie": "app=2; Path=/",
        location: "/relative",
      });
      res.write("data: first\n\n");
      finish = () => res.end("data: end\n\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const activity = new PreviewActivity();
  const target = {
    orbId: "orb",
    port,
    registrationId: "generation",
    incarnation: 2,
    executionId: "execution",
    runtimeInstanceId: "runtime",
  };
  const agent = {
    previewActivity: activity,
    runtimeInstanceId: "runtime",
    getHealth: () => ({ status: "ready", ...target }),
    gateView: () => ({ acceptingWork: true }),
  } as unknown as OrbAgent;
  const app = Fastify();
  await app.register(websocket);
  const service = new RuntimePreviewService({
    agent,
    orbId: "orb",
    verifier: new HmacPreviewVerifier("secret"),
    reservedPorts: () => [],
  });
  await app.register(async (scope) => registerPreviewRoutes(scope, service));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      target,
      origin: "https://preview.example",
      expiresAt: Date.now() + 10000,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", createHash("sha256").update("secret").digest("hex"))
    .update(`pi-orb-preview-admission-v1\n${encoded}`)
    .digest("base64url");
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        `${app.listeningOrigin}/v1/preview/${port}`,
        {
          method: "POST",
          headers: {
            "x-pi-orb-preview-admission": `${encoded}.${signature}`,
            "x-pi-orb-preview-path": Buffer.from("/nested/page?x=%2F").toString("base64url"),
            host: "spoof.example",
            "x-forwarded-host": "spoof.example",
            "x-forwarded-proto": "http",
            forwarded: "host=spoof.example;proto=http",
            "x-pi-orb-preview-application-authorization": "Bearer application",
            cookie: "app=1",
            "content-type": "application/octet-stream",
          },
        },
        (res) => {
          expect(res.headers.location).toBe("/relative");
          expect(res.headers["set-cookie"]).toEqual(["app=2; Path=/"]);
          let first = true;
          res.on("data", (chunk) => {
            if (!first) return;
            first = false;
            expect(chunk.toString()).toBe("data: first\n\n");
            expect(activity.blocksIdle()).toBe(true);
            finish?.();
          });
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(Buffer.from([0, 255, 12]));
    });
    expect(applicationHost).toBe("preview.example");
    expect(forwardingHost).toBe("preview.example");
    expect(forwardingProto).toBe("https");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
