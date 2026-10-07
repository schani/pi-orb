import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { startPreviewApplication } from "./testkit/preview-application.ts";
import { startPreviewComposition } from "./testkit/preview-composition.ts";
import { startPreviewViteApplication } from "./testkit/preview-vite-application.ts";

it("composes Google auth, registration CLI and real runtime HTTP/SSE/binary/WS/Vite forwarding", async () => {
  const application = await startPreviewApplication();
  const wrong = await startPreviewApplication();
  const vite = await startPreviewViteApplication();
  console.info("preview-composed: fixtures-ready");
  const fixture = await startPreviewComposition([application.port, wrong.port, vite.port]);
  console.info("preview-composed: composition-ready");
  const browser = await chromium.launch({ proxy: { server: fixture.proxyUrl } });
  try {
    const [origin, wrongOrigin, viteOrigin] = fixture.previewOrigins;
    if (!origin || !wrongOrigin || !viteOrigin) throw new Error("Composition origins missing");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${fixture.appOrigin}/auth/login`);
    await page.waitForURL(`${fixture.appOrigin}/`);
    console.info("preview-composed: google-ready");
    const missing = page.waitForResponse(
      (response) => response.url() === `${origin}/` && response.status() === 404,
    );
    await page.goto(`${origin}/`);
    await missing;
    console.info("preview-composed: unregistered-denied");
    expect((await context.request.get(`${origin}/asset.js`)).status()).toBe(404);
    expect(application.requests).toHaveLength(0);
    const stable = await fixture.cli(["expose", String(application.port)]);
    expect(stable).toBe(origin);
    console.info("preview-composed: registration-ready");
    expect(await fixture.cli(["expose", String(application.port)])).toBe(stable);
    const list = JSON.parse(await fixture.cli(["previews", "--json"]));
    expect(list.previews).toHaveLength(1);
    expect(list.previews[0]).toMatchObject({ port: application.port, url: stable });
    const loaded = await page.goto(`${origin}/nested/`, { timeout: 10_000 });
    expect(
      loaded?.status(),
      JSON.stringify({
        body: await page.locator("body").innerText(),
        upstream: application.requests.map((request) => request.path),
      }),
    ).toBe(200);
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
    console.info("preview-composed: application-ready");
    expect(application.requests.map((request) => request.path)).toContain("/nested/asset.js");
    for (const path of ["/api/private", "/runtime/previews"]) {
      const applicationPath = await context.request.get(`${origin}${path}`);
      expect(applicationPath.status()).toBe(200);
      expect(await applicationPath.text()).toContain("Loopback preview");
    }
    const redirect = await context.request.get(`${origin}/redirect`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["location"]).toBe("./nested?redirected=1");
    await context.addCookies([{ name: "application", value: "sent", url: origin }]);
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const upload = await context.request.post(`${origin}/upload`, {
      data: bytes,
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
    expect(await upload.body()).toEqual(bytes);
    const seen = application.requests.at(-1);
    expect(seen?.headers.authorization).toBe("Bearer application");
    expect(seen?.headers.cookie).toContain("application=sent");
    expect(JSON.stringify(seen?.headers)).not.toMatch(
      /pi-orb-preview|pi-orb-session|platform-secret|spoofed/,
    );
    expect(
      (await context.cookies(origin)).some(
        (cookie) => cookie.name === "application" && cookie.value === "kept",
      ),
    ).toBe(true);
    expect(
      await page.evaluate(`(async () => {
      const response = await fetch('/binary');
      const reader = response.body.getReader();
      Object.assign(window, { previewBinaryReader: reader });
      return Array.from((await reader.read()).value);
    })()`),
    ).toEqual([0, 255, 128]);
    application.finishBinary();
    expect(
      await page.evaluate(
        `(async () => Array.from((await window.previewBinaryReader.read()).value))()`,
      ),
    ).toEqual([13, 10]);
    await page.evaluate(`(() => {
      const events = new EventSource("/events");
      events.addEventListener("ready", (event) => { document.body.dataset.event = event.data; });
      events.onmessage = (event) => { document.body.dataset.event = event.data; };
      Object.assign(window, { previewEvents: events });
    })()`);
    console.info("preview-composed: upload-verified");
    await application.streamOpened;
    await page.waitForFunction('document.body.dataset.event === "open"');
    application.sendEvent("barrier");
    await page.waitForFunction('document.body.dataset.event === "barrier"');
    const wrongPage = await context.newPage();
    // Authenticate the second origin independently; no copied preview session is sufficient.
    const wrongResponse = wrongPage.waitForResponse(
      (response) => response.url() === `${wrongOrigin}/` && response.status() === 404,
    );
    await wrongPage.goto(`${wrongOrigin}/`);
    await wrongResponse;
    expect(wrong.requests).toHaveLength(0);
    expect(await fixture.cli(["expose", String(vite.port)])).toBe(viteOrigin);
    const vitePage = await context.newPage();
    const connected = new Promise<void>((resolve, reject) => {
      vitePage.on("websocket", (socket) => {
        console.info("preview-composed: vite-ws", socket.url().split("?")[0]);
        socket.on("socketerror", (error) => reject(new Error(`Vite WS: ${error}`)));
      });
      vitePage.on("console", (message) => {
        console.info(
          "preview-composed: vite-console",
          message.text().replaceAll(/token=[^\s&]+/g, "token=redacted"),
        );
        if (message.text() === "[vite] connected.") resolve();
      });
    });
    const viteLoaded = await vitePage.goto(`${viteOrigin}/`);
    await vitePage.waitForURL(`${viteOrigin}/`);
    expect(
      (await context.request.get(`${viteOrigin}/`)).status(),
      await vitePage.locator("body").innerText(),
    ).toBe(200);
    void viteLoaded;
    await vitePage.waitForFunction('document.body.dataset.value === "before"');
    console.info("preview-composed: vite-root-ready");
    await connected;
    await vite.update("after");
    await vitePage.waitForFunction('document.body.dataset.value === "after"');
    console.info("preview-composed: vite-hmr-verified");
    await page.evaluate(`(() => {
      const socket = new WebSocket(location.origin.replace("https:", "wss:") + "/echo");
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { socket.send(new Uint8Array([0, 255])); document.body.dataset.sent = "yes"; };
      socket.onmessage = (event) => { document.body.dataset.echo = Array.from(new Uint8Array(event.data)).join(","); };
      socket.onclose = () => { document.body.dataset.closed = "yes"; };
      Object.assign(window, { previewSocket: socket });
    })()`);
    await page.waitForFunction('document.body.dataset.sent === "yes"');
    await application.socketOpened;
    console.info("preview-composed: ws-upstream-opened");
    try {
      await page.waitForFunction('document.body.dataset.echo === "0,255"', undefined, {
        timeout: 5_000,
      });
    } catch (cause) {
      throw new Error(
        `Immediate WS echo mismatch: ${JSON.stringify({ frames: application.frames, browser: await page.evaluate("({...document.body.dataset})") })}`,
        { cause },
      );
    }
    console.info("preview-composed: ws-echo-verified");
    expect(fixture.activity.blocksIdle()).toBe(true);
    await fixture.cli(["unexpose", String(application.port)]);
    expect((await context.request.get(`${origin}/`)).status()).toBe(404);
    await page.waitForFunction('document.body.dataset.closed === "yes"');
    expect(await fixture.cli(["expose", String(application.port)])).toBe(stable);
    const registered = JSON.parse(await fixture.cli(["previews", "--json"]));
    expect(
      registered.previews.find((item: { port: number }) => item.port === application.port)
        .registrationId,
    ).not.toBe(list.previews[0].registrationId);
    const observations = fixture.observed();
    expect((await fixture.stopOrb()).isOk()).toBe(true);
    expect((await context.request.get(`${origin}/`)).status()).toBe(503);
    expect(fixture.observed()).toBe(observations);
    const authority = await fixture.h.store.readPreviewAuthority(fixture.task, {
      orbId: fixture.orbId,
      port: application.port,
    });
    expect(authority._unsafeUnwrap()?.registration).not.toBeNull();
    expect(authority._unsafeUnwrap()?.orb.state).toBe("stopping");
  } finally {
    await browser.close();
    await fixture.close();
    await Promise.all([application.close(), wrong.close(), vite.close()]);
  }
}, 30_000);
