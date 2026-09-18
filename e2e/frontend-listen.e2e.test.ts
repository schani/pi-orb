import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { observeFrontendBoot } from "./testkit/frontend-fixture.ts";

it("reports listen failures through the test framework and releases its error listener", async () => {
  const httpServer = createHttpServer();
  const listen = vi.spyOn(httpServer, "listen").mockImplementation(() => {
    httpServer.emit("error", new Error("synthetic bind failure"));
    return httpServer;
  });
  try {
    await expect(listenFrontend({ httpServer })).rejects.toThrow("synthetic bind failure");
    expect(httpServer.listenerCount("error")).toBe(0);
    await expect(listenFrontend({ httpServer: null })).rejects.toThrow("requires an HTTP server");
  } finally {
    listen.mockRestore();
  }
});

it("reports bounded browser request progress when application boot stalls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orb-frontend-diagnostic-"));
  await writeFile(
    join(root, "index.html"),
    `<body><main id="root"></main><p>static shell</p><script>
      console.error("/relative-error?token=hidden#fragment");
      window.addEventListener("load", () => {
        for (const source of [
          "/src/missing.ts?token=hidden",
          "/controlled-finished.js?token=hidden",
          "/controlled-pending.js?token=hidden",
        ]) {
          const script = document.createElement("script");
          script.type = "module";
          script.src = source;
          document.head.append(script);
        }
      });
    </script></body>`,
  );
  const vite = await createServer({ root, configFile: false });
  const browser = await chromium.launch({ headless: true });
  let releasePending!: () => void;
  const pendingGate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  try {
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No diagnostic fixture port");
    const page = await browser.newPage();
    await page.route("**/controlled-finished.js?*", async (route) => {
      await route.fulfill({ contentType: "text/javascript", body: "globalThis.finished = true" });
    });
    await page.route("**/controlled-pending.js?*", async (route) => {
      await pendingGate;
      await route.fulfill({ contentType: "text/javascript", body: "globalThis.pending = true" });
    });
    const boot = observeFrontendBoot(page);
    const moduleFailure = page.waitForResponse(
      (response) => response.url().includes("/src/missing.ts?") && response.status() >= 400,
    );
    const finishedRequest = page.waitForEvent("requestfinished", {
      predicate: (request) => request.url().includes("/controlled-finished.js?"),
    });
    const pendingRequest = page.waitForRequest((request) =>
      request.url().includes("/controlled-pending.js?"),
    );
    await Promise.all([
      page.goto(`http://127.0.0.1:${address.port}/?fixture-secret=hidden#fragment`),
      moduleFailure,
      finishedRequest,
      pendingRequest,
    ]);
    expect(await page.getByText("static shell", { exact: true }).isVisible()).toBe(true);
    let diagnostic = "";
    try {
      await boot.wait(
        Promise.reject(
          new Error(
            "controlled readiness rejection https://fixture-user:fixture-password@example.test/module?token=hidden#fragment",
          ),
        ),
      );
    } catch (cause) {
      diagnostic = cause instanceof Error ? cause.message : String(cause);
    }
    expect(diagnostic).toContain("controlled readiness rejection https://example.test/module");
    expect(diagnostic).toContain(
      'readiness={"document":"complete","appRoot":true,"appChildren":0,"fixtureControl":false}',
    );
    expect(diagnostic).toMatch(
      /requests={"started":6,"finished":4,"failed":1,"pending":\["script http:\/\/127\.0\.0\.1:\d+\/controlled-pending\.js"\]}/,
    );
    expect(diagnostic).toMatch(/response: 404 http:\/\/127\.0\.0\.1:\d+\/src\/missing\.ts/);
    expect(diagnostic).not.toMatch(/hidden|fixture-user|fixture-password|fragment/);
    const pendingFinished = page.waitForEvent("requestfinished", {
      predicate: (request) => request.url().includes("/controlled-pending.js?"),
    });
    releasePending();
    await pendingFinished;
  } finally {
    releasePending();
    await browser.close();
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("asks the owned Node server for an ephemeral port, never Vite's preview-port fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orb-frontend-port-"));
  const vite = await createServer({
    root,
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  if (vite.httpServer === null) throw new Error("Expected an HTTP server");
  const listen = vi.spyOn(vite.httpServer, "listen");
  try {
    await listenFrontend(vite);
    expect(listen.mock.calls[0]?.[0]).toBe(0);
    const address = vite.httpServer.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
  } finally {
    listen.mockRestore();
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});
