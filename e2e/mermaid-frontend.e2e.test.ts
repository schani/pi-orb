import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-diagrams";

it.each(["chromium", "webkit"] as const)(
  "%s: renders Mermaid fences as boards with source, viewer and parse errors",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-mermaid-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Browser | undefined;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const executable =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser =
        engine === "webkit"
          ? await webkit.launch()
          : await chromium.launch({
              ...(executable === undefined ? {} : { executablePath: executable }),
              args: ["--no-sandbox"],
            });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const renders: { outcome: string }[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror ${error.message}`));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400 && !path.startsWith(`/api/v1/orbs/${ORB}/headlines/`))
          errors.push(`${response.status()} ${path}`);
      });
      await page.exposeFunction("__mermaidRender", (detail: { outcome: string }) =>
        renders.push(detail),
      );
      await page.addInitScript(`
        const load = document.fonts.load.bind(document.fonts);
        document.fonts.load = (...args) =>
          load(...args).then((fonts) => {
            const history = document.querySelector(".history");
            if (!args[0].startsWith("12px") || !history) return fonts;
            // Release measuring renders during deep observer delivery, not a timer.
            return new Promise((resolve) => {
              const probe = document.createElement("div");
              history.append(probe);
              const observer = new ResizeObserver(() => {
                observer.disconnect();
                probe.remove();
                resolve(fonts);
              });
              observer.observe(probe);
            });
          });
        const measurements = [];
        Reflect.set(globalThis, "__mermaidMeasurements", measurements);
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof HTMLDivElement) || !node.id.startsWith("dpi-mermaid-"))
                continue;
              const parent = record.target;
              const style = parent.style;
              measurements.push({ position: style.position, visibility: style.visibility, parent });
            }
          }
        }).observe(document, { childList: true, subtree: true });
      `);
      await page.addInitScript(() => {
        const debug = console.debug.bind(console);
        console.debug = (...args) => {
          if (args[0] === "mermaid render")
            (globalThis as unknown as { __mermaidRender: (d: unknown) => void }).__mermaidRender(
              args[1],
            );
          debug(...args);
        };
      });

      await gotoFrontendHistory(page, `http://127.0.0.1:${address.port}/orbs/${ORB}`, ORB);
      const boards = page.locator(".mermaid-diagram");
      await expect(boards).toHaveCount(4);
      await expect.poll(() => renders.length).toBe(4);
      expect(renders.map((r) => r.outcome).sort()).toEqual([
        "parse_failed",
        "rendered",
        "rendered",
        "rendered",
      ]);

      const flow = boards.nth(0);
      await expect(flow.locator(".mermaid-canvas svg")).toBeVisible();
      await expect(flow.locator('[data-look="neo"]')).toHaveCount(0);
      await expect(flow.locator(".mermaid-tools")).toHaveCSS("opacity", "0");
      await flow.hover();
      await expect(flow.locator(".mermaid-tools")).toHaveCSS("opacity", "1");

      // Actors are boxes, not stick figures.
      const sequence = boards.nth(1);
      await expect(sequence.locator("g.actor-man rect.actor-you")).toHaveCount(1);
      await expect(sequence.locator("g.actor-man line, g.actor-man circle")).toHaveCount(0);

      await flow.getByRole("button", { name: "Show Mermaid source" }).click();
      await expect(flow.locator("pre code")).toContainText("flowchart LR");
      await expect(flow.locator(".mermaid-canvas")).toBeHidden();
      await flow.getByRole("button", { name: "Show diagram" }).click();
      await expect(flow.locator(".mermaid-canvas svg")).toBeVisible();

      await sequence.hover();
      await sequence.getByRole("button", { name: "Open diagram" }).click();
      const dialog = page.locator("dialog.mermaid-dialog");
      await expect(dialog.locator("svg")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      const broken = boards.nth(3);
      await expect(broken.locator(".mermaid-error")).toHaveText("Mermaid: parse error on line 4");
      await expect(broken.locator("pre code")).toContainText('A --> S["Support API"');
      await expect(broken.getByRole("button", { name: "Open diagram" })).toHaveCount(0);
      const measurements = await page.evaluate(() =>
        (
          Reflect.get(globalThis, "__mermaidMeasurements") as {
            position: string;
            visibility: string;
            parent: { isConnected: boolean };
          }[]
        ).map(({ parent, ...style }) => ({
          ...style,
          connected: parent.isConnected,
        })),
      );
      expect(measurements.length).toBeGreaterThanOrEqual(3);
      for (const measurement of measurements)
        expect(measurement).toEqual({ position: "fixed", visibility: "hidden", connected: false });
      const source = `%%{init: {"securityLevel": "loose"}}%%
flowchart LR
  A["<img src=x onerror='globalThis.__mermaidUnsafe = true'>"]
  click A "javascript:globalThis.__mermaidUnsafe=true"`;
      const security = await page.evaluate(`(async () => {
        const { renderMermaid } = await import("/src/lib/mermaid-render.ts");
        const unsafe = await renderMermaid(${JSON.stringify(source)});
        const math = await renderMermaid('flowchart LR\\n A["$$E=mc^2$$"]');
        const template = document.createElement("template");
        template.innerHTML = unsafe.isOk() ? unsafe.value : "";
        const mathTemplate = document.createElement("template");
        mathTemplate.innerHTML = math.isOk() ? math.value : "";
        return {
          unsafeRendered: unsafe.isOk(),
          mathRendered: math.isOk(),
          mathLabels: mathTemplate.content.querySelectorAll(".katex").length,
          unsafeElements: template.content.querySelectorAll("script, [onerror], [onclick]").length,
          unsafeLinks: [...template.content.querySelectorAll("a")].filter((a) =>
            [...a.attributes].some((attr) => /href$/i.test(attr.name) && /^javascript:/i.test(attr.value)),
          ).length,
          executed: Reflect.get(globalThis, "__mermaidUnsafe") === true,
        };
      })()`);
      expect(security).toEqual({
        unsafeRendered: true,
        mathRendered: true,
        mathLabels: 1,
        unsafeElements: 0,
        unsafeLinks: 0,
        executed: false,
      });
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
