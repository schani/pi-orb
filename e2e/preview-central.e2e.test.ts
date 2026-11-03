import { type Browser, chromium } from "@playwright/test";
import { it as baseIt, expect } from "vitest";
import { startPreviewComposition } from "./testkit/preview-composition.ts";
import { startPreviewDockerRuntime } from "./testkit/preview-docker.ts";

const it = baseIt.skipIf(process.env["PI_ORB_E2E_BACKEND"] === "process");

it("forwards previews registered by central-Pi tools through the image's execution server", async () => {
  const runtime = await startPreviewDockerRuntime({ execution: true });
  let fixture: Awaited<ReturnType<typeof startPreviewComposition>> | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await startPreviewComposition(runtime.ports, runtime);
    browser = await chromium.launch({ proxy: { server: fixture.proxyUrl } });
    const [origin] = fixture.previewOrigins;
    if (!origin) throw new Error("Central preview origin missing");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${fixture.appOrigin}/auth/login`);
    await page.waitForURL(`${fixture.appOrigin}/`);
    // Document navigation runs the preview-origin login handoff, then reaches the unregistered port.
    const missing = page.waitForResponse(
      (response) => response.url() === `${origin}/` && response.status() === 404,
    );
    await page.goto(`${origin}/`);
    await missing;

    const registration = await fixture.tool("orb_expose_port", { port: 3000 });
    expect(registration).toEqual({ port: 3000, registrationId: expect.any(String), url: origin });
    expect(await fixture.tool("orb_list_previews", {})).toEqual([registration]);
    await page.goto(`${origin}/nested/`);
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
    expect((await runtime.info()).requests.map((request) => request.path)).toContain(
      "/nested/asset.js",
    );
    await page.evaluate(`(() => {
      const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/echo');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(new Uint8Array([0, 255]));
      socket.onmessage = (event) => document.body.dataset.echo = Array.from(new Uint8Array(event.data)).join(',');
      socket.onclose = () => document.body.dataset.closed = 'yes';
      Object.assign(window, { previewSocket: socket });
    })()`);
    await page.waitForFunction('document.body.dataset.echo === "0,255"');

    expect(await fixture.tool("orb_unexpose_port", { port: 3000 })).toEqual({
      port: 3000,
      revoked: true,
    });
    expect((await context.request.get(`${origin}/`)).status()).toBe(404);
    await page.waitForFunction('document.body.dataset.closed === "yes"');
    expect(await fixture.tool("orb_list_previews", {})).toEqual([]);
  } finally {
    await browser?.close();
    await fixture?.close();
    await runtime.close();
  }
});
