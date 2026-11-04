import { type Browser, chromium } from "@playwright/test";
import { it as baseIt, expect } from "vitest";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
} from "../apps/control-plane/src/domain/access-token.ts";
import { startPreviewComposition } from "./testkit/preview-composition.ts";
import { startPreviewDockerRuntime } from "./testkit/preview-docker.ts";

const it = baseIt.skipIf(process.env["PI_ORB_E2E_BACKEND"] === "process");

it("opens previews and hosted files with an orb id-token, without Google login, across stop/start", async () => {
  const runtime = await startPreviewDockerRuntime({ execution: true });
  let fixture: Awaited<ReturnType<typeof startPreviewComposition>> | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await startPreviewComposition(runtime.ports, runtime);
    browser = await chromium.launch({ proxy: { server: fixture.proxyUrl } });
    const [origin] = fixture.previewOrigins;
    if (!origin) throw new Error("Preview origin missing");
    expect(await fixture.tool("orb_expose_port", { port: 3000 })).toMatchObject({ url: origin });
    const token = (await fixture.idToken())._unsafeUnwrap();
    // A context that never logged in; the cookie is what `agent-browser cookies set` installs.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    expect((await context.request.get(`${origin}/`)).status()).toBe(401);
    const scripted = await context.request.get(`${origin}/`, {
      headers: { [ACCESS_TOKEN_HEADER]: token },
    });
    expect(scripted.status()).toBe(200);
    for (const url of [origin, fixture.filesOrigin])
      await context.addCookies([
        { name: ACCESS_TOKEN_COOKIE, value: token, url, secure: true, httpOnly: true },
      ]);
    const page = await context.newPage();
    const file = await page.goto(`${fixture.filesOrigin}/s/${fixture.orbId}/token.html`);
    expect(file?.status()).toBe(200);
    const echo = async () => {
      await page.waitForFunction('document.body.dataset.asset === "loaded"');
      await page.evaluate(`(() => {
        const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/echo');
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => socket.send(new Uint8Array([0, 255]));
        socket.onmessage = (event) => document.body.dataset.echo = Array.from(new Uint8Array(event.data)).join(',');
        socket.onclose = () => document.body.dataset.closed = 'yes';
      })()`);
      await page.waitForFunction('document.body.dataset.echo === "0,255"');
    };
    await page.goto(`${origin}/nested/`);
    await echo();

    // The trigger: an agent's open preview survives a compute stop/start without a human tab.
    const stopping = (await fixture.stopOrb())._unsafeUnwrap();
    await page.waitForFunction('document.body.dataset.closed === "yes"');
    const stopped = await fixture.h.store.casTransition(fixture.task, {
      orbId: fixture.orbId,
      expectedStateVersion: stopping.stateVersion,
      toState: "stopped",
      now: fixture.task.wallNow(),
    });
    expect(stopped.isOk()).toBe(true);
    const starting = (await fixture.startOrb())._unsafeUnwrap();
    await runtime.restart();
    const running = await fixture.h.store.casTransition(fixture.task, {
      orbId: fixture.orbId,
      expectedStateVersion: starting.stateVersion,
      toState: "running",
      now: fixture.task.wallNow(),
    });
    expect(running.isOk()).toBe(true);
    await page.reload();
    await echo();
  } finally {
    await browser?.close();
    await fixture?.close();
    await runtime.close();
  }
}, 90_000);
