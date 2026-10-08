import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, type Page, webkit } from "@playwright/test";
import { describe, it } from "vitest";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

describe("owned route teardown", () => {
  it("does not call close before the route body and fulfillment drain", async () => {
    const drain = barrier();
    const cleanupEntered = barrier();
    const events: string[] = [];
    const page = {
      async unrouteAll(options: Parameters<Page["unrouteAll"]>[0]) {
        assert.deepEqual(options, { behavior: "wait" });
        events.push("drain entered");
        cleanupEntered.release();
        await drain.reached;
        events.push("body parsed", "fulfilled");
      },
      async close() {
        events.push("close");
        cleanupEntered.release();
      },
    };
    const cleanup = closeRoutedPage(page);
    await cleanupEntered.reached;
    try {
      assert.deepEqual(events, ["drain entered"]);
    } finally {
      drain.release();
      await cleanup;
    }
    assert.deepEqual(events, ["drain entered", "body parsed", "fulfilled", "close"]);
  });

  it.each(["chromium", "webkit"] as const)(
    "%s keeps the fetched response owned until its body and route fulfill complete",
    async (engine) => {
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ owned: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
      const page = await browser.newPage();
      const afterFetch = barrier();
      const beforeBody = barrier();
      const cleanupEntered = barrier();
      const fulfilled = barrier();
      const events: string[] = [];
      let cleanup: Promise<void> | undefined;
      let navigation: Promise<unknown> | undefined;
      await page.route("**/owned", async (route) => {
        const response = await route.fetch();
        events.push("fetched");
        afterFetch.release();
        await beforeBody.reached;
        const body = await response.json();
        assert.deepEqual(body, { owned: true });
        events.push("body parsed");
        await route.fulfill({ json: body });
        events.push("fulfilled");
        fulfilled.release();
      });
      try {
        navigation = page.goto(`http://127.0.0.1:${address.port}/owned`);
        await afterFetch.reached;
        cleanup = closeRoutedPage({
          async unrouteAll(options) {
            const draining = page.unrouteAll(options);
            events.push("drain entered");
            cleanupEntered.release();
            await draining;
          },
          async close() {
            events.push("close entered");
            cleanupEntered.release();
            // Navigation is owned too: release it before closing its page.
            await navigation;
            await page.close();
          },
        });
        await cleanupEntered.reached;
        assert.deepEqual(events, ["fetched", "drain entered"]);
        assert.equal(page.isClosed(), false);
        beforeBody.release();
        await fulfilled.reached;
        await cleanup;
        assert.deepEqual(events, [
          "fetched",
          "drain entered",
          "body parsed",
          "fulfilled",
          "close entered",
        ]);
        assert.equal(page.isClosed(), true);
      } finally {
        beforeBody.release();
        if (cleanup) await cleanup;
        if (navigation) await navigation;
        if (!page.isClosed()) {
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        }
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
