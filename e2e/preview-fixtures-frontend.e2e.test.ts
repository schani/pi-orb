import { once } from "node:events";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { startPreviewApplication } from "./testkit/preview-application.ts";
import { startPreviewViteApplication } from "./testkit/preview-vite-application.ts";

it("owns a loopback fixture supporting relative assets, redirects, binary uploads, SSE and WS", async () => {
  const app = await startPreviewApplication();
  try {
    expect(await (await fetch(`${app.origin}/nested/asset.js`)).text()).toContain("loaded");
    expect(
      (await fetch(`${app.origin}/redirect`, { redirect: "manual" })).headers.get("location"),
    ).toBe("./nested?redirected=1");
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    const upload = await fetch(`${app.origin}/upload`, {
      method: "POST",
      body: binary,
      headers: { authorization: "Bearer application", cookie: "application=sent" },
    });
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(binary);
    expect(upload.headers.get("set-cookie")).toContain("application=kept");
    expect(app.requests.at(-1)?.headers).toMatchObject({
      authorization: "Bearer application",
      cookie: "application=sent",
    });
    const stream = await fetch(`${app.origin}/events`);
    await app.streamOpened;
    if (!stream.body) throw new Error("Fixture SSE body missing");
    const reader = stream.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    app.sendEvent("barrier");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: barrier");
    await reader.cancel();
    const socket = new WebSocket(`${app.origin.replace("http:", "ws:")}/socket`);
    await once(socket, "open");
    const received = once(socket, "message");
    socket.send(binary);
    const [bytes, isBinary] = await received;
    expect(bytes).toEqual(binary);
    expect(isBinary).toBe(true);
    socket.close();
    await once(socket, "close");
  } finally {
    await app.close();
  }
});

it("assigns distinct owned Vite listeners", async () => {
  const first = await startPreviewViteApplication();
  const second = await startPreviewViteApplication();
  try {
    expect(first.port).not.toBe(second.port);
    expect((await fetch(first.origin)).status).toBe(200);
    expect((await fetch(second.origin)).status).toBe(200);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

it("drives an actual Vite HMR update after browser client readiness", async () => {
  const app = await startPreviewViteApplication();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const connected = new Promise<void>((resolve) =>
      page.on("console", (message) => {
        if (message.text() === "[vite] connected.") resolve();
      }),
    );
    await page.goto(app.origin);
    await page.waitForFunction('document.body.dataset.value === "before"');
    await connected;
    await app.update("after");
    await page.waitForFunction('document.body.dataset.value === "after"');
  } finally {
    await browser.close();
    await app.close();
  }
});
