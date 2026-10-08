import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, type Page, type Route, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory, observeFrontendBoot } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-activity-headlines";
const sessionId = `fixture-session-${ORB}`;
const cases = [
  "first seen",
  "two-request cap",
  "scope replay result",
  "failure manual Retry",
  "code headers",
] as const;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(
  (["chromium", "webkit"] as const).flatMap((engine) =>
    cases.map((scenario) => ({ engine, scenario })),
  ),
)("$engine: activity headlines $scenario", async ({ engine, scenario }) => {
  // Each case owns its server, browser, routes and cache; no preview server or provider.
  {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-headlines-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Browser | undefined;
    let page: Page | undefined;
    const drains: ReturnType<typeof gate>[] = [];
    const handlers: Promise<void>[] = [];
    let drainSources: (() => Promise<void>) | undefined;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      expect(address && typeof address !== "string").toBeTruthy();
      if (!address || typeof address === "string") return;
      const origin = `http://127.0.0.1:${address.port}`;
      const executablePath =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser =
        engine === "webkit"
          ? await webkit.launch()
          : await chromium.launch({
              ...(executablePath ? { executablePath } : {}),
              args: ["--no-sandbox"],
            });
      page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
      await page.clock.install();
      const fixturePage = page;
      const control = async (action: string) => {
        const response = await fixturePage.request.post(
          `${origin}/api/v1/orbs/${ORB}/fixture-headline-control`,
          { data: { action, scenario } },
        );
        expect(response.status(), `${scenario}: opt-in headline fixture ${action}`).toBe(200);
        return response.json();
      };
      await control("seed");
      drainSources = async () => {
        await control("replicate");
      };
      let expectedSession = sessionId;
      const requests: string[] = [];
      let returning = false;
      let active = 0;
      let maximum = 0;
      const held: {
        key: string;
        session: string | null;
        route: Route;
        gate: ReturnType<typeof gate>;
        done: ReturnType<typeof gate>;
      }[] = [];
      await page.route(`**/api/v1/orbs/${ORB}/headlines/**`, (route) => {
        const task = (async () => {
          const url = new URL(route.request().url());
          expect(route.request().method()).toBe("POST");
          expect(route.request().postData()).toBeNull();
          const session = url.searchParams.get("sessionId");
          // A cached view may briefly request its prior session before the live snapshot.
          expect(returning ? [sessionId, expectedSession] : [expectedSession]).toContain(session);
          const key = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
          expect(key).not.toBe("");
          requests.push(key);
          active++;
          maximum = Math.max(maximum, active);
          const release = gate();
          const done = gate();
          drains.push(release);
          held.push({ key, session, route, gate: release, done });
          if (returning && key !== "old-intent") release.release();
          await release.promise;
          try {
            if (key === "old-intent" && url.searchParams.get("sessionId") === sessionId) {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ headline: "STALE_HEADLINE_MUST_NOT_PUBLISH" }),
              });
            } else {
              const response = await route.fetch();
              await route.fulfill({ response });
            }
          } finally {
            active--;
            done.release();
          }
        })();
        handlers.push(task);
        return task;
      });
      let documentRequests = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests++;
      });
      await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
      const rows = page.locator("details.tool-activity-category");
      const summaries = rows.locator(":scope > summary");
      const flush = async () => {
        await fixturePage.clock.runFor(100);
      };
      const release = (key: string) => {
        const request = held.findLast((item) => item.key === key);
        expect(request, `held ${key}`).toBeDefined();
        request?.gate.release();
      };
      if (scenario === "code headers") {
        let detailReads = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.includes(`/${ORB}/details/`)) detailReads++;
        });
        await expect.poll(() => [...requests].sort()).toEqual(["code-bash", "code-codemode"]);
        await expect(rows).toHaveCount(7);
        for (const index of [0, 1, 4]) {
          await expect(summaries.nth(index).locator("code")).toHaveText("HEADLINE_DETAIL_BODY");
          await expect(summaries.nth(index).locator("code")).toHaveCSS("white-space", "nowrap");
        }
        await expect(summaries.nth(2)).toContainText("Ready from history");
        await expect(summaries.nth(2).locator("code")).toHaveCount(0);
        await expect(summaries.nth(3).locator(".activity-rail-headline")).toHaveText("");
        await expect(summaries.nth(3).locator("code")).toHaveCount(0);
        await expect(summaries.nth(5)).toContainText("commands");
        await expect(summaries.nth(5).locator("code")).toHaveCount(0);
        await expect(summaries.last()).toContainText("3 ran");
        await expect(summaries.last().locator(".activity-rail-headline")).toHaveCount(0);
        release("code-bash");
        release("code-codemode");
        await expect(summaries.first()).toContainText("Headline code-bash");
        await expect(summaries.nth(1)).toContainText("Headline code-codemode");
        await control("code-result");
        await expect.poll(() => requests.at(-1)).toBe("code-result");
        await expect(summaries.first().locator("code")).toHaveText("HEADLINE_DETAIL_BODY");
        await expect(summaries.first()).not.toContainText("Headline code-bash");
        release("code-result");
        await expect(summaries.first()).toContainText("Headline code-result");
        expect(detailReads).toBe(0);
        expect(requests).toHaveLength(3);
        await summaries.last().click();
        await expect.poll(() => requests.length).toBe(5);
        const children = page.locator(".tool-activity-call > summary");
        await expect(children).toHaveCount(3);
        for (const child of await children.all())
          await expect(child).toContainText("HEADLINE_DETAIL_BODY");
        const activeGroup = held.filter((item) => item.key.startsWith("code-group-"));
        expect(activeGroup).toHaveLength(2);
        for (const item of activeGroup) item.gate.release();
        await expect.poll(() => requests.length).toBe(6);
        for (const item of held.filter((item) => item.key.startsWith("code-group-")))
          item.gate.release();
        await expect(children.last()).toContainText("Headline code-group-three");
        expect(detailReads).toBe(0);
      } else if (scenario === "first seen") {
        await expect.poll(() => [...requests].sort()).toEqual(["seen-arbitrary", "seen-null"]);
        await expect(rows).toHaveCount(6);
        expect(await rows.first().getAttribute("open")).toBeNull();
        await expect(summaries.nth(2)).toContainText("Ready from history");
        await summaries.last().click();
        await expect(page.locator(".tool-activity-call > summary")).toHaveCount(2);
        await flush();
        await page.setViewportSize({ width: 1100, height: 350 });
        await page.locator(".tool-activity-call > summary").last().scrollIntoViewIfNeeded();
        const activeBox = await summaries.first().boundingBox();
        const scrollBox = await page.locator(".orb-transcript-scroll").boundingBox();
        expect(
          activeBox !== null && scrollBox !== null && activeBox.y + activeBox.height <= scrollBox.y,
          "active header is cropped",
        ).toBe(true);
        release("seen-null");
        release("seen-arbitrary");
        await Promise.all(
          held.filter((item) => item.key.startsWith("seen-")).map((item) => item.done.promise),
        );
        await expect(summaries.first()).toContainText("Headline seen-null");
        await expect.poll(() => requests.length).toBe(4);
        await summaries.last().click();
        await page.evaluate(() => {
          const scope = globalThis as unknown as {
            document: { dispatchEvent(event: unknown): void };
            scrollTo(x: number, y: number): void;
            Event: new (name: string) => unknown;
          };
          Object.defineProperty(scope.document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          scope.document.dispatchEvent(new scope.Event("visibilitychange"));
          scope.scrollTo(0, 0);
        });
        release("group-one");
        release("group-two");
        await Promise.all(
          held.filter((item) => item.key.startsWith("group-")).map((item) => item.done.promise),
        );
        await page.evaluate(() => {
          const scope = globalThis as unknown as {
            document: { dispatchEvent(event: unknown): void };
            Event: new (name: string) => unknown;
          };
          Object.defineProperty(scope.document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
          scope.document.dispatchEvent(new scope.Event("visibilitychange"));
        });
        await summaries.last().click();
        await expect(page.locator(".tool-activity-call").first()).toContainText(
          "Headline group-one",
        );
        await expect(page.locator(".tool-activity-call").last()).toContainText(
          "Headline group-two",
        );
        await flush();
        expect([...requests].sort()).toEqual([
          "group-one",
          "group-two",
          "seen-arbitrary",
          "seen-null",
        ]);
      } else if (scenario === "two-request cap") {
        await expect.poll(() => requests.length).toBe(2);
        await control("third");
        await expect(rows).toHaveCount(3);
        await summaries.last().scrollIntoViewIfNeeded();
        await summaries.first().click();
        await expect(rows.first()).toContainText("HEADLINE_DETAIL_BODY");
        await expect(
          page.getByRole("textbox", { name: "Message the orb", exact: true }),
        ).toBeEnabled();
        await flush();
        expect([...requests].sort()).toEqual(["cap-one", "cap-two"]);
        await page.setViewportSize({ width: 1100, height: 350 });
        await summaries.first().scrollIntoViewIfNeeded();
        const queuedBox = await summaries.nth(2).boundingBox();
        expect(
          queuedBox !== null && (queuedBox.y >= 350 || queuedBox.y + queuedBox.height <= 0),
          "seen queued header is cropped",
        ).toBe(true);
        release("cap-one");
        await expect.poll(() => requests).toContain("cap-three");
        await control("fourth");
        await expect(rows).toHaveCount(4);
        await summaries.last().scrollIntoViewIfNeeded();
        await flush();
        await page.goto(`${origin}/`);
        release("cap-two");
        release("cap-three");
        await flush();
        expect(requests).not.toContain("cap-four");
        expect(maximum).toBe(2);
      } else if (scenario === "scope replay result") {
        await expect.poll(() => requests).toEqual(["scope-intent"]);
        release("scope-intent");
        await expect(summaries.first()).toContainText("Headline scope-intent");
        await control("replay");
        await flush();
        expect(requests).toEqual(["scope-intent"]);
        await control("live");
        await expect.poll(() => requests).toEqual(["scope-intent", "live-intent"]);
        let historyReads = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.endsWith(`/${ORB}/history`)) historyReads++;
        });
        release("live-intent");
        await expect.poll(async () => (await control("inspect")).waiting).toContain("live-intent");
        expect((await control("inspect")).liveConnections).toBe(1);
        await control("replicate");
        await expect(summaries.last()).toContainText("Headline live-intent");
        expect(historyReads).toBe(0);
        expect(requests.filter((key) => key === "live-intent")).toHaveLength(1);
        expect((await control("inspect")).liveConnections).toBe(1);
        await control("result");
        await expect.poll(() => requests.at(-1)).toBe("scope-result");
        release("scope-result");
        await expect(summaries.first()).toContainText("Headline scope-result");
        await control("replay");
        await flush();
        expect(requests.filter((key) => key === "scope-result")).toHaveLength(1);
        await control("late");
        await expect.poll(() => requests.at(-1)).toBe("late-intent");
        await control("late-result");
        await expect.poll(() => requests.at(-1)).toBe("late-result");
        release("late-result");
        await expect(summaries.last()).toContainText("Headline late-result");
        release("late-intent");
        await held.find((item) => item.key === "late-intent")?.done.promise;
        await flush();
        await expect(summaries.last()).toContainText("Headline late-result");
        const navigate = async (destination: "dashboard" | "orb") => {
          const boot = observeFrontendBoot(fixturePage);
          boot.checkpoint(`scope:navigate:${destination}`);
          await boot.wait(
            (async () => {
              await fixturePage
                .locator(
                  destination === "dashboard"
                    ? '.orb-index a[href="/"]'
                    : `.dashboard a[href="/orbs/${ORB}"]`,
                )
                .click();
              await expect(fixturePage).toHaveURL(
                destination === "dashboard" ? `${origin}/` : `${origin}/orbs/${ORB}`,
              );
              await expect(fixturePage.locator(".history")).toHaveCount(
                destination === "dashboard" ? 0 : 1,
              );
              await expect
                .poll(async () => (await control("inspect")).liveConnections)
                .toBe(destination === "dashboard" ? 0 : 1);
              boot.checkpoint("scope:mounted-and-live-settled");
            })(),
          );
        };
        await control("old");
        await expect.poll(() => requests.at(-1)).toBe("old-intent");
        await navigate("dashboard");
        // Return may use enriched history or POST to the backend cache; hold only stale work.
        returning = true;
        await navigate("orb");
        await expect(summaries.first()).toContainText("Headline scope-result");
        await navigate("dashboard");
        expectedSession = `${sessionId}-new`;
        await control("new-session");
        await navigate("orb");
        await expect
          .poll(
            () =>
              held.filter((item) => item.key === "old-intent" && item.session === expectedSession)
                .length,
          )
          .toBe(1);
        const fresh = held.find(
          (item) => item.key === "old-intent" && item.session === expectedSession,
        );
        expect(fresh).toBeDefined();
        fresh?.gate.release();
        await expect(summaries.first()).toContainText("Headline old-intent");
        for (const stale of held.filter((item) => item.key === "old-intent" && item !== fresh))
          stale.gate.release();
        await Promise.all(
          held.filter((item) => item.key === "old-intent").map((item) => item.done.promise),
        );
        await flush();
        await expect(summaries.first()).toContainText("Headline old-intent");
        await expect(page.locator(".history")).not.toContainText("STALE_HEADLINE_MUST_NOT_PUBLISH");
        expect(documentRequests, "stale responses must settle in the original document").toBe(1);
      } else {
        await expect.poll(() => requests).toEqual(["failure-intent"]);
        const pendingLabel = await summaries.first().textContent();
        await expect(summaries.first().locator("code")).toHaveText("HEADLINE_DETAIL_BODY");
        await control("fail");
        await control("replay");
        await page.route(`**/api/v1/orbs/${ORB}/details/**`, (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "unavailable",
                message: "Fixture details unavailable",
                retryable: true,
              },
            }),
          }),
        );
        await summaries.first().click();
        await expect(rows.first().getByRole("alert")).toContainText("Fixture details unavailable");
        await expect(
          page.getByRole("textbox", { name: "Message the orb", exact: true }),
        ).toBeEnabled();
        await flush();
        expect(await summaries.first().textContent()).toBe(pendingLabel);
        await expect(summaries.first().locator(".error-text")).toHaveCount(0);
        await expect(summaries.first().getByRole("button", { name: "Retry" })).toHaveCount(0);
        expect(requests).toHaveLength(1);
        release("failure-intent");
        await expect(summaries.first()).toContainText("Summary unavailable.");
        await expect(summaries.first().locator("code")).toHaveCount(0);
        const badColor = await page.evaluate<string>(`(() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--bad)';
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        })()`);
        await expect(
          summaries.first().getByText("Summary unavailable.", { exact: true }),
        ).toHaveCSS("color", badColor);
        await expect(
          summaries.first().getByRole("button", { name: "Retry", exact: true }),
        ).toHaveCSS("color", badColor);
        await control("replay");
        await flush();
        expect(requests).toHaveLength(1);
        await expect(rows.first().getByRole("alert")).toContainText("Fixture details unavailable");
        await expect(summaries.first()).toContainText("Summary unavailable.");
        await page.unroute(`**/api/v1/orbs/${ORB}/details/**`);
        await rows
          .first()
          .getByRole("alert")
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await expect(rows.first()).toContainText("HEADLINE_DETAIL_BODY");
        await expect(summaries.first()).toContainText("Summary unavailable.");
        await page.setViewportSize({ width: 1100, height: 350 });
        await page.getByText("Failure boundary 29.", { exact: true }).scrollIntoViewIfNeeded();
        await flush();
        await summaries.first().scrollIntoViewIfNeeded();
        await expect(summaries.first()).toContainText("Summary unavailable.");
        expect(requests).toHaveLength(1);
        await summaries.first().click();
        await flush();
        expect(requests).toHaveLength(1);
        await control("success");
        await summaries.first().getByRole("button", { name: "Retry", exact: true }).click();
        expect(await rows.first().getAttribute("open")).toBeNull();
        await expect.poll(() => requests.length).toBe(2);
        expect(await summaries.first().textContent()).toBe(pendingLabel);
        await expect(summaries.first().locator(".error-text")).toHaveCount(0);
        await expect(summaries.first().getByRole("button", { name: "Retry" })).toHaveCount(0);
        await flush();
        expect(requests).toHaveLength(2);
        held[1]?.gate.release();
        await expect(summaries.first()).toContainText("Headline failure-intent");
        await flush();
        expect(requests).toHaveLength(2);
      }
    } finally {
      await drainSources?.();
      for (const drain of drains) drain.release();
      await page?.unrouteAll({ behavior: "ignoreErrors" });
      await page?.close();
      await Promise.allSettled(handlers);
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
});
