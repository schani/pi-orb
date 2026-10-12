import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { EXECUTION_READY_PATH, type RuntimeHealth } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { createExecutionPreview } from "./preview.ts";
import { buildExecutionServer } from "./server.ts";

const health: RuntimeHealth = {
  v: 1,
  status: "ready",
  orbId: "orb",
  runtimeInstanceId: "runtime",
  executionId: "execution",
  incarnation: 2,
  sessionId: "execution-orb",
  checkoutCommit: null,
  activity: "idle",
};

function admission(target: Record<string, unknown>): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      target,
      origin: "https://preview.example",
      expiresAt: Date.now() + 10_000,
    }),
  ).toString("base64url");
  const key = createHash("sha256").update("secret").digest("hex");
  const signature = createHmac("sha256", key)
    .update(`pi-orb-preview-admission-v1\n${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

it("forwards HMAC-admitted previews to loopback while other routes keep bearer auth", async () => {
  const upstream = createServer((request, response) => {
    response.end(`app ${request.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let ready = true;
  const app = buildExecutionServer({
    token: "secret",
    incarnation: "2",
    cwd: "/unused",
    ready: () => null,
    preview: createExecutionPreview({
      boot: {
        runtimeInstanceId: "runtime",
        health: () => health,
        accepting: () => ready,
      },
      orbId: "orb",
      token: "secret",
      reservedPorts: () => [8080],
    }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const target = {
    orbId: "orb",
    port,
    registrationId: "registration",
    incarnation: 2,
    executionId: "execution",
    runtimeInstanceId: "runtime",
  };
  const preview = (signed: string) =>
    fetch(`${app.listeningOrigin}/v1/preview/${port}`, {
      headers: {
        "x-pi-orb-preview-admission": signed,
        "x-pi-orb-preview-path": Buffer.from("/page?x=1").toString("base64url"),
      },
    });
  try {
    const forwarded = await preview(admission(target));
    expect(forwarded.status).toBe(200);
    expect(await forwarded.text()).toBe("app /page?x=1");
    const stale = await preview(admission({ ...target, incarnation: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.headers.get("x-pi-orb-preview-error")).toBe("stale_target");
    const forged = await preview(`${admission(target)}x`);
    expect(forged.status).toBe(401);
    ready = false;
    expect((await preview(admission(target))).status).toBe(503);
    expect((await fetch(`${app.listeningOrigin}${EXECUTION_READY_PATH}`)).status).toBe(401);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
