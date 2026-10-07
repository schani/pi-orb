import { type Browser, chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { startPreviewComposition } from "./testkit/preview-composition.ts";
import { startPreviewDockerRuntime } from "./testkit/preview-docker.ts";

it("forwards authenticated previews into the image-baked runtime's Docker namespace and retains registrations across stop/start", async () => {
  const runtime = await startPreviewDockerRuntime();
  let fixture: Awaited<ReturnType<typeof startPreviewComposition>> | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await startPreviewComposition(runtime.ports, runtime);
    browser = await chromium.launch({ proxy: { server: fixture.proxyUrl } });
    const [origin, wrongOrigin, viteOrigin] = fixture.previewOrigins;
    if (!origin || !wrongOrigin || !viteOrigin) throw new Error("Docker preview origins missing");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${fixture.appOrigin}/auth/login`);
    await page.waitForURL(`${fixture.appOrigin}/`);
    const missing = page.waitForResponse(
      (response) => response.url() === `${origin}/` && response.status() === 404,
    );
    await page.goto(`${origin}/`);
    await missing;
    expect((await runtime.info()).requests).toHaveLength(0);
    expect(await fixture.cli(["expose", "3000"])).toBe(origin);
    expect(await fixture.cli(["expose", "3000"])).toBe(origin);
    const initial = JSON.parse(await fixture.cli(["previews", "--json"]));
    expect(initial.previews).toHaveLength(1);
    await page.goto(`${origin}/nested/`);
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
    expect((await runtime.info()).requests.map((request) => request.path)).toContain(
      "/nested/asset.js",
    );
    for (const path of ["/api/private", "/runtime/previews"]) {
      const applicationPath = await context.request.get(`${origin}${path}`);
      expect(applicationPath.status()).toBe(200);
      expect(await applicationPath.text()).toContain("Loopback preview");
    }
    const redirect = await context.request.get(`${origin}/redirect`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["location"]).toBe("./nested?redirected=1");
    await context.addCookies([{ name: "application", value: "sent", url: origin }]);
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    const upload = await context.request.post(`${origin}/upload`, {
      data: binary,
      headers: {
        authorization: "Bearer application",
        "content-type": "application/octet-stream",
        "x-pi-orb-preview-admission": "spoofed",
        "x-goog-iap-jwt-assertion": "platform-secret",
      },
    });
    expect(upload.status()).toBe(200);
    expect(upload.headers()["x-pi-orb-preview-error"]).toBeUndefined();
    expect(upload.headers()["x-goog-iap-jwt-assertion"]).toBeUndefined();
    expect(upload.headers()["set-cookie"]).not.toMatch(/pi-orb-preview|parent=forged/);
    expect(await upload.body()).toEqual(binary);
    const seen = (await runtime.info()).requests.at(-1);
    expect(seen?.headers.authorization).toBe("Bearer application");
    expect(seen?.headers.cookie).toContain("application=sent");
    expect(JSON.stringify(seen?.headers)).not.toMatch(
      /pi-orb-preview|pi-orb-session|platform-secret|spoofed/,
    );
    expect(
      await page.evaluate(`(async () => {
      const response = await fetch('/binary');
      const reader = response.body.getReader();
      Object.assign(window, { previewBinaryReader: reader });
      return Array.from((await reader.read()).value);
    })()`),
    ).toEqual([0, 255, 128]);
    await runtime.finishBinary();
    expect(
      await page.evaluate(
        `(async () => Array.from((await window.previewBinaryReader.read()).value))()`,
      ),
    ).toEqual([13, 10]);
    await page.evaluate(`(() => {
      const events = new EventSource('/events');
      events.addEventListener('ready', (event) => document.body.dataset.event = event.data);
      events.onmessage = (event) => document.body.dataset.event = event.data;
      Object.assign(window, { previewEvents: events });
    })()`);
    await page.waitForFunction('document.body.dataset.event === "open"');
    await runtime.event("stream-barrier");
    await page.waitForFunction('document.body.dataset.event === "stream-barrier"');
    const wrongPage = await context.newPage();
    const blocked = wrongPage.waitForResponse(
      (response) => response.url() === `${wrongOrigin}/` && response.status() === 404,
    );
    await wrongPage.goto(`${wrongOrigin}/`);
    await blocked;
    expect((await runtime.info()).wrongRequests).toBe(0);
    expect(await fixture.cli(["expose", "3002"])).toBe(viteOrigin);
    const vitePage = await context.newPage();
    const connected = new Promise<void>((resolve) =>
      vitePage.on("console", (message) => {
        if (message.text() === "[vite] connected.") resolve();
      }),
    );
    await vitePage.goto(`${viteOrigin}/`);
    await vitePage.waitForFunction('document.body.dataset.value === "before"');
    await connected;
    await runtime.update("after");
    await vitePage.waitForFunction('document.body.dataset.value === "after"');
    await page.evaluate(`(() => {
      const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/echo');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(new Uint8Array([0, 255]));
      socket.onmessage = (event) => document.body.dataset.echo = Array.from(new Uint8Array(event.data)).join(',');
      socket.onclose = () => document.body.dataset.closed = 'yes';
      Object.assign(window, { previewSocket: socket });
    })()`);
    await page.waitForFunction('document.body.dataset.echo === "0,255"', undefined, {
      timeout: 5_000,
    });
    expect((await runtime.info()).active).toBe(true);
    await fixture.cli(["unexpose", "3000"]);
    expect((await context.request.get(`${origin}/`)).status()).toBe(404);
    await page.waitForFunction('document.body.dataset.closed === "yes"');
    expect(await fixture.cli(["expose", "3000"])).toBe(origin);
    const registered = JSON.parse(await fixture.cli(["previews", "--json"]));
    const generation = registered.previews.find(
      (item: { port: number }) => item.port === 3000,
    ).registrationId;
    expect(generation).not.toBe(initial.previews[0].registrationId);
    const observed = fixture.observed();
    const stopping = (await fixture.stopOrb())._unsafeUnwrap();
    expect((await context.request.get(`${origin}/`)).status()).toBe(503);
    expect(fixture.observed()).toBe(observed);
    // Lifecycle completion is a fixture boundary; stop/start intents and CAS are production domain/store.
    const stopped = (
      await fixture.h.store.casTransition(fixture.task, {
        orbId: fixture.orbId,
        expectedStateVersion: stopping.stateVersion,
        toState: "stopped",
        now: fixture.task.wallNow(),
      })
    )._unsafeUnwrap();
    expect(stopped.state).toBe("stopped");
    expect((await context.request.get(`${origin}/`)).status()).toBe(503);
    const starting = (await fixture.startOrb())._unsafeUnwrap();
    const beforeRestart = await runtime.info();
    await runtime.restart();
    const afterRestart = await runtime.info();
    expect(afterRestart.runtimeInstanceId).not.toBe(beforeRestart.runtimeInstanceId);
    expect(afterRestart.executionId).not.toBe(beforeRestart.executionId);
    expect((await context.request.get(`${origin}/`)).status()).toBe(503);
    expect(fixture.observed()).toBe(observed);
    expect(
      (
        await fixture.h.store.casTransition(fixture.task, {
          orbId: fixture.orbId,
          expectedStateVersion: starting.stateVersion,
          toState: "running",
          now: fixture.task.wallNow(),
        })
      ).isOk(),
    ).toBe(true);
    const retained = JSON.parse(await fixture.cli(["previews", "--json"]));
    expect(retained.previews.find((item: { port: number }) => item.port === 3000)).toMatchObject({
      registrationId: generation,
      url: origin,
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
  } finally {
    await browser?.close();
    await fixture?.close();
    await runtime.close();
  }
}, 60_000);
