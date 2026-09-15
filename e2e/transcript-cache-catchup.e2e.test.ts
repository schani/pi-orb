import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";

it.each(["chromium", "webkit"] as const)(
  "%s: unseen delivered input waits for initial live catch-up instead of downloading full history",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "test-cache-hello-gate",
          enforce: "pre",
          transform(code, id) {
            if (!id.endsWith("/lib/live.ts")) return;
            return code.replace(
              "ws.onopen = () => {",
              'ws.onopen = async () => { await Reflect.get(globalThis, "__cacheHelloGate")?.(options.orbId);',
            );
          },
        },
      ],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    const observer = await browser.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    try {
      await page.addInitScript(() => {
        const fetch = globalThis.fetch;
        Reflect.set(globalThis, "__historyStarts", 0);
        globalThis.fetch = (...args) => {
          if (
            Reflect.get(globalThis, "__holdCacheHello") &&
            String(args[0]).endsWith("/frontend-long-history/history")
          ) {
            Reflect.set(
              globalThis,
              "__historyStarts",
              Reflect.get(globalThis, "__historyStarts") + 1,
            );
          }
          return fetch(...args);
        };
        Reflect.set(globalThis, "__cacheHelloGate", (orbId: string) => {
          if (orbId !== "frontend-long-history" || !Reflect.get(globalThis, "__holdCacheHello"))
            return;
          return new Promise<void>((resolve) => {
            Reflect.set(globalThis, "__releaseCacheHello", resolve);
          });
        });
      });
      await page.goto(`${origin}/#/orbs/${a}`);
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      await check(ready).toBeEnabled();
      await page.locator(`.orb-index a[href="#/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      // This fixture's agent pump is socket-owned (unlike a real runtime). An
      // independent observer supplies that pump while the tested page is on B.
      await observer.goto(`${origin}/#/orbs/${a}`);
      await check(
        observer.getByRole("button", { name: "Change thinking", exact: true }),
      ).toBeEnabled();
      const messageId = randomUUID();
      const sent = await page.request.put(`${origin}/api/v1/orbs/${a}/messages/${messageId}`, {
        data: { content: [{ type: "text", text: "arrived while away" }] },
      });
      check(sent.status()).toBe(202);
      await check
        .poll(async () => {
          const response = await page.request.get(`${origin}/api/v1/orbs/${a}/messages`);
          const view = await response.json();
          return view.items.find((item: { id: string; status: string }) => item.id === messageId)
            ?.status;
        })
        .toBe("delivered");
      await check(observer.locator(".history .rec-orb").last()).toContainText("arrived while away");
      await check(
        observer.getByRole("button", { name: "Change thinking", exact: true }),
      ).toBeEnabled();
      // Opening the settings picker is allowed while busy, and rendered echo
      // text can still be transient. Only committed history releases the pump.
      await check
        .poll(async () => {
          const response = await page.request.get(`${origin}/api/v1/orbs/${a}/history`);
          const view = await response.json();
          return view.records.some(
            (record: { role?: string; content?: { type: string; text?: string }[] }) =>
              record.role === "assistant" &&
              record.content?.some((block) => block.text?.includes("arrived while away")),
          );
        })
        .toBe(true);
      await observer.close();
      await page.evaluate(() => Reflect.set(globalThis, "__holdCacheHello", true));
      await page.locator(`.orb-index a[href="#/orbs/${a}"]`).click();
      // A provisional delivered turn proves the real inbox poll has applied while
      // client.hello is deliberately held. Count fetch initiation synchronously.
      await check(page.locator(".history")).toContainText("arrived while away");
      check(await page.evaluate(() => Reflect.get(globalThis, "__historyStarts"))).toBe(0);
      await check
        .poll(() => page.evaluate(() => typeof Reflect.get(globalThis, "__releaseCacheHello")))
        .toBe("function");
      await page.evaluate(() => Reflect.get(globalThis, "__releaseCacheHello")());
      await check(ready).toBeEnabled();
      await check(page.locator(".history .rec-orb").last()).toContainText("arrived while away");
      await check(
        page.locator(".history .rec-you").filter({ hasText: "arrived while away" }),
      ).toHaveCount(1);
      check(await page.evaluate(() => Reflect.get(globalThis, "__historyStarts"))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(globalThis, "__releaseCacheHello")?.());
      await observer.close();
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
