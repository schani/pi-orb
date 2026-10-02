import { join } from "node:path";
import { expect as check, chromium, type Page, type WebSocket, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

function lastTraceOutcome(page: Page, event: string, orbId: string) {
  return page.evaluate(
    ({ event, id }) => {
      const debug = globalThis as typeof globalThis & {
        piOrbDebug: {
          dump(): { trace: { event: string; orbId?: string; outcome?: string }[] };
        };
      };
      return debug.piOrbDebug
        .dump()
        .trace.filter((entry) => entry.event === event && entry.orbId === id)
        .at(-1)?.outcome;
    },
    { event, id: orbId },
  );
}

it.each(["chromium", "webkit"] as const)(
  "%s: history 404 retires live ownership even when metadata is still running",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    let state = "stopped",
      refresh = false,
      holdMetadata = false,
      holdReturnMetadata = false;
    let releaseHistory = () => {},
      releaseMetadata = () => {},
      releaseReturnMetadata = () => {};
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const returnMetadataGate = new Promise<void>((resolve) => {
      releaseReturnMetadata = resolve;
    });
    let acknowledgeReturnEntry = () => {};
    const returnEntry = new Promise<void>((resolve) => {
      acknowledgeReturnEntry = resolve;
    });
    let acknowledgeHeldMetadata = () => {};
    const heldMetadata = new Promise<void>((resolve) => {
      acknowledgeHeldMetadata = resolve;
    });
    const waits: Promise<unknown>[] = [];
    const own = <T>(promise: Promise<T>) => {
      const settled = promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      waits.push(settled);
      return settled;
    };
    const required = async <T>(pending: ReturnType<typeof own<T>>) => {
      const result = await pending;
      if (!result.ok) throw result.error;
      return result.value;
    };
    const sockets = new Set<WebSocket>();
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith(`/orbs/${a}/live`)) return;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    try {
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        const responseState = state;
        const waitForReturn = holdReturnMetadata;
        const waitForPoll = holdMetadata;
        if (waitForReturn) acknowledgeReturnEntry();
        const response = await route.fetch();
        if (waitForReturn) await returnMetadataGate;
        if (waitForPoll) {
          acknowledgeHeldMetadata();
          await metadataGate;
        }
        return route.fulfill({
          response,
          json: { ...(await response.json()), state: responseState },
        });
      });
      await page.route(`**/orbs/${a}/history`, async (route) => {
        if (!refresh) return route.continue();
        await historyGate;
        return route.fulfill({
          status: 404,
          json: { error: { code: "not_found", message: "Orb doesn't exist", retryable: false } },
        });
      });
      await gotoFrontendHistory(page, `${origin}/orbs/${a}`, a);
      await check(page.locator(".history")).toContainText("Review 100");
      // A visible row does not prove retained cache state; the return cache hit does.
      await check.poll(() => lastTraceOutcome(page, "cache", a)).toBe("stored");
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      refresh = true;
      holdReturnMetadata = true;
      const historyRequested = own(
        page.waitForRequest((request) => request.url().endsWith(`/orbs/${a}/history`)),
      );
      const returnMetadataRequested = own(
        page.waitForRequest((request) => request.url().endsWith(`/api/v1/orbs/${a}`)),
      );
      const returnedMetadata = own(
        page.waitForResponse(
          (response) => response.url().endsWith(`/api/v1/orbs/${a}`) && response.status() === 200,
        ),
      );
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await required(returnMetadataRequested);
      await returnEntry;
      // Flip the next-request gate while the return request is paused in its producer.
      // That request must retain its entry ownership and complete independently.
      holdMetadata = true;
      // A held load leaves B painted; history visibility alone cannot end this wait.
      await check(page.locator(".history")).toContainText("Frontend playground");
      releaseReturnMetadata();
      await required(returnedMetadata);
      holdMetadata = false;
      await check.poll(() => lastTraceOutcome(page, "navigation", a)).toBe("cache_hit");
      await check(page.locator(".history")).toContainText("Review 100");
      await required(historyRequested);
      // A newer metadata poll starts live synchronization while the older HTTP
      // request is held. Its definitive 404 must still retire all live ownership.
      state = "running";
      await check(page.getByRole("button", { name: "Change thinking", exact: true })).toBeEnabled();
      await check.poll(() => sockets.size).toBe(1);
      holdMetadata = true;
      await heldMetadata;
      const missingResponse = own(
        page.waitForResponse(
          (response) => response.url().endsWith(`/orbs/${a}/history`) && response.status() === 404,
        ),
      );
      releaseHistory();
      await required(missingResponse);
      const staleMetadataResponse = own(
        page.waitForResponse(
          (response) => response.url().endsWith(`/api/v1/orbs/${a}`) && response.status() === 200,
        ),
      );
      releaseMetadata();
      await required(staleMetadataResponse);
      await check(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible();
      await check.poll(() => sockets.size).toBe(0);
      check(page.url()).toBe(`${origin}/orbs/${a}`);
    } finally {
      releaseHistory();
      releaseMetadata();
      releaseReturnMetadata();
      await page.close();
      await Promise.all(waits);
      await browser.close();
      await vite.close();
    }
  },
);
