import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { HOSTING_FILES_PATH } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { NoSimulationTask } from "determined";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHostingAccessPolicy,
  registerHostingAccessGuard,
} from "../apps/control-plane/src/http/hosting-access.ts";
import {
  registerBrowserHostingRoutes,
  registerRuntimeHostingRoutes,
} from "../apps/control-plane/src/http/hosting-routes.ts";
import { makeHarness, makeOrbRow } from "../apps/control-plane/src/testkit/fixtures.ts";

const ORB = "00000000-0000-4000-8000-000000000171";
const TOKEN = "hosting-security-runtime-token";
const task = new NoSimulationTask("hosting browser isolation", false);
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("loopback server did not receive a TCP port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

describe("hosted-file browser origin isolation", () => {
  let browser: Browser;
  let app: ReturnType<typeof Fastify>;
  let appOrigin: string;
  let filesOrigin: string;
  let apiReads = 0;
  let mutations = 0;
  let socketHandlers = 0;

  beforeAll(async () => {
    const port = await unusedLoopbackPort();
    appOrigin = `http://127.0.0.1:${port}`;
    filesOrigin = `http://files.localhost:${port}`;
    const harness = makeHarness({ hostingOrbId: ORB });
    harness.store.seedOrb(
      makeOrbRow(ORB, "project", "running", {
        hostIncarnation: 1,
        runtimeTokenHash: digest(TOKEN),
      }),
    );
    app = Fastify();
    const policy = createHostingAccessPolicy({ filesOrigin });
    expect(policy.isOk()).toBe(true);
    if (policy.isErr()) return;
    registerHostingAccessGuard(app, policy.value, appOrigin);
    const deps = {
      appOrigin,
      filesOrigin,
      hosting: harness.hosting.deps,
      store: harness.store,
    };
    await registerRuntimeHostingRoutes(app, task, deps);
    registerBrowserHostingRoutes(app, task, deps);
    app.get("/seed", (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .header("set-cookie", "pi_orb_test=credential; Path=/; SameSite=Lax")
        .type("text/html")
        .send("seeded"),
    );
    app.get("/api/private", () => {
      apiReads++;
      return { secret: "must-not-cross-origin" };
    });
    app.post("/api/mutate", () => {
      mutations++;
      return { changed: true };
    });
    app.get("/api/socket", () => {
      socketHandlers++;
      return { connected: true };
    });

    const publish = async (path: string, body: string, mediaType: string) => {
      const response = await app.inject({
        method: "POST",
        url: `${HOSTING_FILES_PATH}?path=${encodeURIComponent(path)}`,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-length": String(Buffer.byteLength(body)),
          "content-type": mediaType,
          host: `127.0.0.1:${port}`,
          "x-pi-orb-request-id": crypto.randomUUID(),
          "x-pi-orb-sha256": digest(body),
        },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
    };
    await publish("site/asset.txt", "relative asset loaded", "text/plain");
    await publish(
      "site/index.html",
      `<!doctype html><body><form action="${appOrigin}/api/mutate" method="post" target="sink"></form><iframe name="sink" hidden></iframe><script>
      window.result = { asset: null, privateBody: null, fetchFailed: false, websocketFailed: false };
      const asset = fetch("asset.txt").then(r => r.text()).then(v => { result.asset = v });
      const privateRead = fetch("${appOrigin}/api/private", { credentials: "include" }).then(r => r.text()).then(v => { result.privateBody = v }).catch(() => { result.fetchFailed = true });
      const socket = new Promise(resolve => { const ws = new WebSocket("ws://127.0.0.1:${port}/api/socket"); ws.onopen = () => resolve(); ws.onerror = () => { result.websocketFailed = true; resolve() } });
      document.querySelector("form").submit();
      Promise.all([asset, privateRead, socket]).then(() => setTimeout(() => { result.done = true }, 100));
      </script>`,
      "text/html; charset=utf-8",
    );
    await app.listen({ host: "127.0.0.1", port });

    const configuredExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
    const systemExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
    browser = await chromium.launch({
      ...(configuredExecutable !== undefined
        ? { executablePath: configuredExecutable }
        : systemExecutable !== undefined
          ? { executablePath: systemExecutable }
          : {}),
      args: ["--no-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  it("loads ordinary hosted assets while hosted script cannot reach the app surface", async () => {
    const page = await browser.newPage();
    await page.goto(`${appOrigin}/seed`);
    await page.goto(`${filesOrigin}/s/${ORB}/site/`);
    await expectPage
      .poll(() =>
        page.evaluate(
          () => (globalThis as unknown as { result?: { done?: boolean } }).result?.done,
        ),
      )
      .toBe(true);
    const result = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            result?: {
              asset: string | null;
              done?: boolean;
              fetchFailed: boolean;
              privateBody: string | null;
              websocketFailed: boolean;
            };
          }
        ).result,
    );
    expect(result).toMatchObject({
      asset: "relative asset loaded",
      fetchFailed: true,
      privateBody: null,
      websocketFailed: true,
    });
    expect({ apiReads, mutations, socketHandlers }).toEqual({
      apiReads: 0,
      mutations: 0,
      socketHandlers: 0,
    });
    await page.close();
  });
});
