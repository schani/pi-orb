import { type Browser, chromium, webkit } from "@playwright/test";
import { afterEach, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../apps/control-plane/src/domain/application-auth.ts";
import { PREVIEW_SESSION_COOKIE_NAME } from "../apps/control-plane/src/domain/preview-auth.ts";
import { startApplicationAuthFixture } from "./testkit/application-auth-fixture.ts";

let browser: Browser | undefined;
let fixture: Awaited<ReturnType<typeof startApplicationAuthFixture>> | undefined;
afterEach(async () => {
  await browser?.close();
  await fixture?.close();
  browser = undefined;
  fixture = undefined;
});

for (const engine of [chromium, webkit]) {
  it(`hands a Google session to exact preview origins without another login (${engine.name()})`, async () => {
    fixture = await startApplicationAuthFixture({ previews: true });
    browser = await engine.launch({ proxy: { server: fixture.proxyUrl } });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const [first, second] = fixture.previewOrigins;
    if (!first || !second) throw new Error("Preview fixture origins missing");
    expect((await context.request.get(`${first}/asset.js`)).status()).toBe(401);
    await page.goto(`${fixture.appOrigin}/auth/login`);
    await page.waitForURL(`${fixture.appOrigin}/`);
    expect(fixture.tokenExchanges()).toBe(1);
    const handoff = page.waitForRequest(
      (request) =>
        request.url() === `${first}/__pi_orb/auth/callback` && request.method() === "POST",
    );
    const handoffResponse = page.waitForResponse(
      (response) =>
        response.url() === `${first}/__pi_orb/auth/callback` &&
        response.request().method() === "POST",
    );
    const responses: { url: string; status: number }[] = [];
    page.on("response", (response) =>
      responses.push({ url: response.url(), status: response.status() }),
    );
    await page.goto(`${first}/nested?x=1`);
    expect(
      (await handoffResponse).status(),
      JSON.stringify({
        responses,
        headers: Object.fromEntries(
          Object.entries(await (await handoff).allHeaders()).filter(([key]) =>
            ["origin", "content-type"].includes(key),
          ),
        ),
      }),
    ).toBe(302);
    try {
      await page.waitForURL(`${first}/nested?x=1`);
    } catch (cause) {
      throw new Error(
        JSON.stringify({
          url: page.url(),
          body: await page.locator("body").innerText(),
          responses,
          callback: Object.fromEntries(
            Object.entries(await (await handoff).allHeaders()).filter(([key]) =>
              ["origin", "content-type", "sec-fetch-site"].includes(key),
            ),
          ),
          cookies: (await context.cookies()).map(({ name, domain, sameSite }) => ({
            name,
            domain,
            sameSite,
          })),
        }),
        { cause },
      );
    }
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
    const callback = await handoff;
    expect((await callback.allHeaders())["origin"]).toBe(fixture.appOrigin);
    expect((await callback.allHeaders())["referer"]).toBe(`${fixture.appOrigin}/`);
    expect(callback.postData()).toMatch(/^ticket=/);
    expect(callback.url()).not.toContain("ticket");
    expect(fixture.tokenExchanges()).toBe(1);
    const cookies = await context.cookies(first);
    expect(cookies.find((cookie) => cookie.name === PREVIEW_SESSION_COOKIE_NAME)).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE_NAME)).toBe(false);
    expect(
      (await context.cookies(second)).some((cookie) => cookie.name === PREVIEW_SESSION_COOKIE_NAME),
    ).toBe(false);
    expect((await context.request.get(`${second}/asset.js`)).status()).toBe(401);
    // A valid cookie for one orb+port is not valid on another origin, even if copied manually.
    const copied = cookies.find((cookie) => cookie.name === PREVIEW_SESSION_COOKIE_NAME);
    if (!copied) throw new Error("Preview session cookie missing");
    expect(
      (
        await context.request.get(`${second}/asset.js`, {
          headers: { cookie: `${copied.name}=${copied.value}` },
        })
      ).status(),
    ).toBe(401);
    await page.goto(`${second}/`);
    await page.waitForURL(`${second}/`);
    await page.waitForFunction('document.body.dataset.asset === "loaded"');
    expect(fixture.tokenExchanges()).toBe(1);
  });
}
