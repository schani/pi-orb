import { expect } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

const ORB = "frontend-fixture-orb";

it.each(["chromium", "webkit"] as const)(
  "%s: initially open stopped-orb image loads with no metadata or inbox rerender",
  async (engine) => {
    const { page, origin } = await createFrontendFixture(engine, {});
    {
      let orbReads = 0;
      let detailReads = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/v1/orbs/${ORB}`, async (route) => {
        orbReads++;
        const response = await route.fetch();
        // StrictMode runs the bootstrap orb load twice; hold only later loads.
        if (orbReads > 2) await held;
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, state: "stopped", activity: "idle" } });
      });
      await page.route(`**/api/v1/orbs/${ORB}/messages/poll`, async (route) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      });
      await page.route(`**/api/v1/orbs/${ORB}/hosted-files`, async (route) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      });
      await page.route(`**/api/v1/orbs/${ORB}/details/**`, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        if (body.includes("Dashboard preview (960")) detailReads++;
        await route.fulfill({ response, body });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
        const image = page
          .locator("details.tool-image-activity")
          .filter({ hasText: "artifacts/dashboard-preview.svg" });
        await expect(image).toBeVisible();
        await expect.poll(() => detailReads).toBe(1);
        await expect(image.locator("img.tool-image-thumbnail, [role=alert]")).toHaveCount(1);
        await expect(image.getByRole("button", { name: "Retry" })).toHaveCount(0);
        await expect(image.locator("img.tool-image-thumbnail")).toHaveCount(1);
        await expect(image.locator("img.tool-image-thumbnail")).toHaveJSProperty("complete", true);
        await expect(image.locator("img.tool-image-thumbnail")).not.toHaveJSProperty(
          "naturalWidth",
          0,
        );
        expect(detailReads, "initial open drawer fetches detail once").toBe(1);
      } finally {
        release();
        await page.close();
      }
    }
  },
);
