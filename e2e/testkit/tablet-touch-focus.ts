import { type Browser, expect as expectPage } from "@playwright/test";
import { gotoFrontendHistory } from "./frontend-fixture.ts";

export async function expectTabletTouchFocus(browser: Browser, origin: string, isMobile: boolean) {
  const page = await browser.newPage({
    viewport: { width: 820, height: 900 },
    hasTouch: true,
    isMobile,
  });
  await page.addInitScript(() => {
    Reflect.set(globalThis, "__composerFocuses", 0);
    Reflect.get(globalThis, "document").addEventListener(
      "focusin",
      (event: { target: { matches: (selector: string) => boolean } }) => {
        if (event.target?.matches?.(".composer-input")) {
          Reflect.set(
            globalThis,
            "__composerFocuses",
            Reflect.get(globalThis, "__composerFocuses") + 1,
          );
        }
      },
    );
  });
  try {
    const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
    await gotoFrontendHistory(
      page,
      `${origin}/orbs/frontend-fixture-orb`,
      "frontend-fixture-orb",
      composer,
    );
    await expectPage(composer).toBeVisible();
    expectPage(await page.evaluate(() => Reflect.get(globalThis, "__composerFocuses"))).toBe(0);
    await expectPage(composer).toHaveCSS("font-size", "16px");
    const rename = page.getByRole("button", { name: "Rename orb", exact: true });
    await rename.focus();
    await expectPage(rename).toBeFocused();
    await page.evaluate(() => {
      const pageDocument = Reflect.get(globalThis, "document");
      Object.defineProperty(pageDocument, "visibilityState", {
        configurable: true,
        get: () => Reflect.get(globalThis, "__testVisibilityState"),
      });
      Reflect.set(globalThis, "__testVisibilityState", "hidden");
      pageDocument.dispatchEvent(new Event("visibilitychange"));
      Reflect.set(globalThis, "__testVisibilityState", "visible");
      pageDocument.dispatchEvent(new Event("visibilitychange"));
    });
    await expectPage(rename).toBeFocused();
    expectPage(await page.evaluate(() => Reflect.get(globalThis, "__composerFocuses"))).toBe(0);
    const geometry = await page.evaluate(() => ({
      scrollWidth: Reflect.get(globalThis, "document").documentElement.scrollWidth,
      clientWidth: Reflect.get(globalThis, "document").documentElement.clientWidth,
      scrollX: Reflect.get(globalThis, "window").scrollX,
    }));
    expectPage(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expectPage(geometry.scrollX).toBe(0);
    await composer.focus();
    await expectPage(composer).toBeFocused();
    expectPage(await page.evaluate(() => Reflect.get(globalThis, "window").scrollX)).toBe(0);
  } finally {
    await page.close();
  }
}
