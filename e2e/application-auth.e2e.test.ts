import { type Browser, chromium, webkit } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
} from "../apps/control-plane/src/domain/application-auth.ts";
import { startApplicationAuthFixture } from "./testkit/application-auth-fixture.ts";

for (const engine of [chromium, webkit]) {
  describe(`Google application auth (${engine.name()})`, () => {
    let browser: Browser | undefined;
    let fixture: Awaited<ReturnType<typeof startApplicationAuthFixture>> | undefined;
    afterEach(async () => {
      await browser?.close();
      await fixture?.close();
      browser = undefined;
      fixture = undefined;
    });
    it("uses signed OIDC, isolated host cookies and fixed stateless expiry", async () => {
      fixture = await startApplicationAuthFixture();
      browser = await engine.launch({ proxy: { server: fixture.proxyUrl } });
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: fixture.proxyUrl },
      });
      const page = await context.newPage();
      const { appOrigin, filesOrigin } = fixture;
      expect((await context.request.get(`${appOrigin}/api/private`)).status()).toBe(401);
      await page.goto(`${appOrigin}/auth/login?returnTo=${encodeURIComponent("/draft?x=1#saved")}`);
      await page.waitForURL(`${appOrigin}/draft?x=1#saved`);
      expect((await context.request.get(`${appOrigin}/api/private`)).status()).toBe(200);
      expect(fixture.tokenExchanges()).toBe(1);
      expect(
        await page.evaluate(
          (origin) =>
            new Promise<string>((resolve) => {
              const ws = new WebSocket(`${origin.replace("https:", "wss:")}/socket`);
              ws.onmessage = (event) => {
                ws.close();
                resolve(String(event.data));
              };
              ws.onerror = () => resolve("denied");
            }),
          appOrigin,
        ),
      ).toBe("admitted");
      const appCookie = (await context.cookies(appOrigin)).find(
        (c) => c.name === SESSION_COOKIE_NAME,
      );
      expect(appCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
      expect((await context.cookies(filesOrigin)).some((c) => c.name === SESSION_COOKIE_NAME)).toBe(
        false,
      );
      expect((await context.request.get(`${filesOrigin}/s/orb/asset.js`)).status()).toBe(401);
      await page.goto(`${filesOrigin}/s/orb/index.html`);
      await page.waitForURL(`${filesOrigin}/s/orb/index.html`);
      await page.waitForFunction('document.body.dataset.asset === "loaded"');
      expect(fixture.tokenExchanges()).toBe(2);
      expect((await context.request.get(`${filesOrigin}/api/private`)).status()).toBe(404);
      expect((await context.request.get(`${appOrigin}/s/orb/index.html`)).status()).toBe(403);
      const denied = await page.evaluate(async (origin) => {
        const fetchDenied = await fetch(`${origin}/api/mutate`, {
          method: "POST",
          credentials: "include",
        }).then(
          () => false,
          () => true,
        );
        const socketDenied = await new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`${origin.replace("https:", "wss:")}/socket`);
          ws.onopen = () => {
            ws.close();
            resolve(false);
          };
          ws.onerror = () => resolve(true);
        });
        return { fetchDenied, socketDenied };
      }, appOrigin);
      expect(denied).toEqual({ fetchDenied: true, socketDenied: true });
      const formResponse = page.waitForResponse(
        (response) =>
          response.url() === `${appOrigin}/api/mutate` && response.request().method() === "POST",
      );
      await page.evaluate(`(() => {
        const frame = document.createElement('iframe'); frame.name = 'attack'; document.body.append(frame);
        const form = document.createElement('form'); form.method = 'POST'; form.target = 'attack';
        form.action = ${JSON.stringify(`${appOrigin}/api/mutate`)}; document.body.append(form); form.submit();
      })()`);
      expect((await formResponse).status()).toBe(403);
      expect(fixture.mutations()).toBe(0);
      const readsBefore = fixture.identityResolutions();
      expect(
        (
          await context.request.post(`${appOrigin}/auth/logout`, { headers: { origin: appOrigin } })
        ).status(),
      ).toBe(204);
      expect((await context.request.get(`${appOrigin}/api/private`)).status()).toBe(401);
      expect((await context.request.get(`${filesOrigin}/s/orb/asset.js`)).status()).toBe(200);
      const copied = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: fixture.proxyUrl },
      });
      if (!appCookie) throw new Error("Login did not set a session cookie");
      await copied.addCookies([appCookie]);
      expect(await (await copied.request.get(`${appOrigin}/api/private`)).json()).toMatchObject({
        principal: { user: { id: "durable-alice" } },
      });
      expect(fixture.identityResolutions()).toBe(readsBefore);
      fixture.account("bob");
      await page.goto(`${appOrigin}/auth/login`);
      await page.waitForURL(`${appOrigin}/`);
      expect(await (await context.request.get(`${appOrigin}/api/private`)).json()).toMatchObject({
        principal: { user: { id: "durable-bob" } },
      });
      expect(await (await copied.request.get(`${appOrigin}/api/private`)).json()).toMatchObject({
        principal: { user: { id: "durable-alice" } },
      });
      expect(
        (
          await context.request.get(`${appOrigin}/api/private`, {
            headers: { authorization: "Bearer invalid" },
          })
        ).status(),
      ).toBe(401);
      fixture.advance(SESSION_LIFETIME_MS - 1);
      expect((await copied.request.get(`${appOrigin}/api/private`)).status()).toBe(200);
      fixture.advance(1);
      expect((await copied.request.get(`${appOrigin}/api/private`)).status()).toBe(401);
      expect(fixture.identityResolutions()).toBe(readsBefore + 1);
      expect(fixture.outcomes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "logout", outcome: "cleared" }),
          expect.objectContaining({ event: "files_login", outcome: "started" }),
        ]),
      );
    });
    it("rejects wrong company, state substitution, code replay and unsafe returns", async () => {
      fixture = await startApplicationAuthFixture();
      browser = await engine.launch({ proxy: { server: fixture.proxyUrl } });
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: fixture.proxyUrl },
      });
      const page = await context.newPage();
      const { appOrigin } = fixture;
      fixture.company("evil.example");
      expect((await page.goto(`${appOrigin}/auth/login`))?.status()).toBe(403);
      expect(fixture.identityResolutions()).toBe(0);
      fixture.company("heyglide.com");
      fixture.substituteState(true);
      expect((await page.goto(`${appOrigin}/auth/login`))?.status()).toBe(401);
      expect(fixture.tokenExchanges()).toBe(1);
      fixture.substituteState(false);
      await page.goto(`${appOrigin}/auth/login`);
      await page.waitForURL(`${appOrigin}/`);
      const replay = fixture.lastCallback();
      const loginCookie = fixture.lastLoginCookie();
      expect(fixture.tokenExchanges()).toBe(2);
      expect(
        (await context.request.get(replay, { headers: { cookie: loginCookie } })).status(),
      ).toBe(401);
      expect(fixture.tokenExchanges()).toBe(3);
      expect((await context.request.get(`${appOrigin}/api/private`)).status()).toBe(200);
      expect(
        (await context.request.get(`${appOrigin}/auth/login?returnTo=//evil.example`)).status(),
      ).toBe(401);
      expect(fixture.identityResolutions()).toBe(1);
    });
  });
}
