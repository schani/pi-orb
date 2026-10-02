import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture, gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const id = "frontend-fixture-orb";
let vite: ViteDevServer;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let origin: string;

beforeAll(async () => {
  browser = await chromium.launch({
    ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
    args: ["--no-sandbox"],
  });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  const root = join(import.meta.dirname, "../apps/web");
  vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
    server: { host: "127.0.0.1", port: 0 },
  });
  await listenFrontend(vite);
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("No owned fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await vite?.close();
});

const screenshots = join(import.meta.dirname, "../.context/orb-alerts/screenshots");

async function alert(page: Page, message: string): Promise<string> {
  const response = await page.request.post(`${origin}/api/v1/orbs/${id}/fixture-alert`, {
    data: { message, requestId: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { recordId: string };
  expect(body.recordId).toEqual(expect.any(String));
  return body.recordId;
}

async function unread(page: Page): Promise<string | null> {
  const response = await page.request.get(`${origin}/api/v1/orbs/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { unreadAlertId?: string }).unreadAlertId ?? null;
}

const flag = 'img[src="/favicons/alert.svg"]';

it("overrides every state surface; explicit selection acknowledges the observed record, not a newer one", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  try {
    const a = await alert(page, "First alert");
    await gotoFrontendFixture(page, `${origin}/`);
    const dashboard = page.locator(".orb-entry", { hasText: "Frontend Playground" });
    await expect(dashboard.locator(flag)).toHaveCount(1);
    await page.keyboard.press("Meta+k");
    const find = page.getByRole("dialog");
    await find.getByRole("searchbox").fill("Frontend Playground");
    await expect(find.locator(flag)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await dashboard.getByRole("link", { name: "Frontend Playground", exact: true }).click();
    await expect.poll(() => unread(page)).toBeNull();
    await expect(page.locator(".rec-alert")).toContainText("First alert");
    await expect(page.locator(`.ix-row[href="/orbs/${id}"]`).locator(flag)).toHaveCount(0);
    await expect(page.locator(".orb-life").locator(flag)).toHaveCount(0);
    await expect(page.locator("#pi-orb-favicon")).not.toHaveAttribute(
      "href",
      "/favicons/alert.svg",
    );

    const b = await alert(page, "New alert while already open");
    await expect(page.locator(".rec-alert")).toHaveCount(2);
    await expect.poll(() => unread(page)).toBe(b);
    await expect(page.locator(".orb-life").locator(flag)).toHaveCount(1);
    await expect(page.locator(`.ix-row[href="/orbs/${id}"]`).locator(flag)).toHaveCount(1);
    await expect(page.locator("#pi-orb-favicon")).toHaveAttribute("href", "/favicons/alert.svg");
    mkdirSync(screenshots, { recursive: true });
    await page
      .locator(".rec-alert", { hasText: "New alert while already open" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, "desktop-new-alert.png") });
    // Replaying an old acknowledgement cannot erase B.
    const stale = await page.request.post(`${origin}/api/v1/orbs/${id}/alerts/ack`, {
      data: { recordId: a },
    });
    expect(stale.ok()).toBe(true);
    expect(((await stale.json()) as { unreadAlertId: string | null }).unreadAlertId).toBe(b);
    await page.locator(`.ix-row[href="/orbs/${id}"]`).click();
    await expect.poll(() => unread(page)).toBeNull();
    await expect(page.locator(".rec-alert")).toHaveCount(2);
    await expect(page.locator(".orb-life").locator(flag)).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it("retains stopped historical alerts after reload and renders hostile multiline text literally on a phone", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  try {
    const message = `<img src=x onerror=alert(1)>\n${"unbroken".repeat(35)}`;
    const recordId = await alert(page, message);
    await gotoFrontendHistory(page, `${origin}/orbs/${id}`, id);
    await expect.poll(() => unread(page)).toBeNull();
    const band = page.locator(".rec-alert", { hasText: "<img src=x onerror=alert(1)>" });
    await expect(band).toBeVisible();
    await expect(band.locator(".alert-band")).toHaveCSS("background-color", "rgb(178, 31, 45)");
    expect(await band.locator("img").count()).toBe(0);
    expect(await band.innerText()).toContain(message);
    const overflow = (await page.evaluate(
      `document.documentElement.scrollWidth - innerWidth`,
    )) as number;
    expect(overflow).toBeLessThanOrEqual(0);
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "phone-literal-alert.png") });
    await page.reload();
    await expect(
      page.locator(".rec-alert", { hasText: "<img src=x onerror=alert(1)>" }),
    ).toHaveCount(1);
    expect(await unread(page)).toBeNull();
    const stop = await page.request.post(`${origin}/api/v1/orbs/${id}/stop`);
    expect(stop.ok()).toBe(true);
    await page.reload();
    await expect(
      page.locator(".rec-alert", { hasText: "<img src=x onerror=alert(1)>" }),
    ).toHaveCount(1);
    expect(await unread(page)).toBeNull();
    const history = await page.request.get(`${origin}/api/v1/orbs/${id}/history`);
    const records = (
      (await history.json()) as { records: { id: string; alert?: { message: string } }[] }
    ).records;
    expect(records.find((entry) => entry.id === recordId)?.alert?.message).toBe(message);
  } finally {
    await page.close();
  }
});

for (const engine of ["chromium", "webkit"] as const) {
  it(`${engine}: keyboard Find selection acknowledges an alert on the already-open orb`, async () => {
    const ownedBrowser = engine === "webkit" ? await webkit.launch() : browser;
    const page = await ownedBrowser.newPage();
    try {
      await gotoFrontendHistory(page, `${origin}/orbs/${id}`, id);
      const recordId = await alert(page, `${engine} Find selection`);
      await expect(page.locator(".rec-alert", { hasText: `${engine} Find selection` })).toHaveCount(
        1,
      );
      await expect(page.locator(".orb-life").locator(flag)).toHaveCount(1);
      expect(await unread(page)).toBe(recordId);
      await page.keyboard.press("Meta+k");
      const find = page.getByRole("dialog", { name: "Find projects and orbs" });
      const query = find.getByRole("searchbox");
      await query.fill("Frontend Playground");
      await expect(find.getByRole("link", { name: /^orb:/ })).toHaveAttribute(
        "href",
        `/orbs/${id}`,
      );
      const selected = find.getByRole("link", { name: /^orb:/ });
      await selected.focus();
      await expect(selected).toBeFocused();
      await selected.press("Enter");
      await expect(find).toBeHidden();
      await expect.poll(() => unread(page)).toBeNull();
      await expect(page.locator(".orb-life").locator(flag)).toHaveCount(0);
      await expect(page.locator(".rec-alert", { hasText: `${engine} Find selection` })).toHaveCount(
        1,
      );
    } finally {
      await page.close();
      if (engine === "webkit") await ownedBrowser.close();
    }
  });

  it(`${engine}: a delayed acknowledgement of A cannot clear B arriving in the same open tab`, async () => {
    const ownedBrowser = engine === "webkit" ? await webkit.launch() : browser;
    const page = await ownedBrowser.newPage();
    let releaseResponse = () => {};
    let announceFetched = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const ackFetched = new Promise<void>((resolve) => {
      announceFetched = resolve;
    });
    try {
      await gotoFrontendHistory(page, `${origin}/orbs/${id}`, id);
      const a = await alert(page, `${engine} delayed A`);
      await expect(page.locator(".orb-life").locator(flag)).toHaveCount(1);
      await page.route(
        `**/api/v1/orbs/${id}/alerts/ack`,
        async (route) => {
          const body = route.request().postDataJSON() as { recordId: string };
          expect(body.recordId).toBe(a);
          const response = await route.fetch(); // A is durably cleared before B arrives.
          announceFetched();
          await responseGate;
          await route.fulfill({ response }); // Deliver the obsolete null response after B.
        },
        { times: 1 },
      );
      const response = page.waitForResponse(
        (reply) =>
          reply.url().endsWith(`/api/v1/orbs/${id}/alerts/ack`) &&
          reply.request().method() === "POST",
      );
      await page.locator(`.ix-row[href="/orbs/${id}"]`).click();
      await ackFetched;
      const b = await alert(page, `${engine} newer B`);
      const observedName = `${engine} observed ${b}`;
      await page.route(`**/api/v1/orbs/${id}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const metadata = await route.fetch();
        const body = (await metadata.json()) as { unreadAlertId?: string; name?: string };
        await route.fulfill({
          response: metadata,
          json: {
            ...body,
            name: body.unreadAlertId === b ? observedName : body.name,
          },
        });
      });
      await expect(page.locator(".rec-alert", { hasText: `${engine} newer B` })).toHaveCount(1);
      await expect(page.locator(".orb-name")).toHaveText(observedName);
      await expect(page.locator(".orb-life").locator(flag)).toHaveCount(1);
      releaseResponse();
      await response;
      expect(await unread(page)).toBe(b);
      await expect(page.locator(".orb-life").locator(flag)).toHaveCount(1);
      await page.locator(`.ix-row[href="/orbs/${id}"]`).click();
      await expect.poll(() => unread(page)).toBeNull();
      await expect(page.locator(".rec-alert", { hasText: `${engine} newer B` })).toHaveCount(1);
    } finally {
      releaseResponse();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      if (engine === "webkit") await ownedBrowser.close();
    }
  });
}

it("red flag overrides running, busy, failed, sleeping, stopped, and archived glyphs", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const recordId = await alert(page, "Flag across states");
    let state = "running";
    let activity: string | undefined;
    let sleepUntil: string | undefined;
    const view = (orb: Record<string, unknown>) => ({
      ...orb,
      state,
      activity,
      sleepUntil,
      unreadAlertId: recordId,
    });
    await page.route(`**/api/v1/orbs/${id}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: view(await response.json()) });
    });
    await page.route("**/api/v1/projects/*/orbs", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.items = body.items.map((orb: Record<string, unknown>) =>
        orb.id === id ? view(orb) : orb,
      );
      await route.fulfill({ response, json: body });
    });
    for (const variant of [
      { state: "running", activity: undefined, sleepUntil: undefined },
      { state: "running", activity: "busy", sleepUntil: undefined },
      { state: "failed", activity: undefined, sleepUntil: undefined },
      { state: "stopped", activity: undefined, sleepUntil: "2026-09-18T00:00:00.000Z" },
      { state: "stopped", activity: undefined, sleepUntil: undefined },
      { state: "archived", activity: undefined, sleepUntil: undefined },
    ]) {
      ({ state, activity, sleepUntil } = variant);
      await gotoFrontendFixture(page, `${origin}/`);
      const entry = page.locator(".orb-entry", {
        has: page.locator(`a[href="/orbs/${id}"]`),
      });
      await expect(entry.locator(flag)).toHaveCount(1);
      await page.keyboard.press("Meta+k");
      const find = page.getByRole("dialog");
      await find.getByRole("searchbox").fill("Frontend Playground");
      await expect(find.locator(flag)).toHaveCount(1);
      await page.keyboard.press("Escape");
      expect(await unread(page)).toBe(recordId);
    }
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});
