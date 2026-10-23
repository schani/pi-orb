import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page, webkit } from "@playwright/test";
import { createServer, type PluginOption, type ViteDevServer } from "vite";
import { onTestFinished } from "vitest";
import { listenFrontend } from "../frontend-listen.ts";

export async function createFrontendFixture(
  engine: "chromium" | "webkit",
  options: { page?: Parameters<Browser["newPage"]>[0]; plugins?: PluginOption[] } = {},
): Promise<{
  browser: Browser;
  page: Page;
  origin: string;
  cleanup(task: () => Promise<unknown>): void;
}> {
  const cleanups: (() => Promise<unknown>)[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "frontend fixture cleanup failed");
  };
  onTestFinished(close);
  try {
    const root = join(import.meta.dirname, "../../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-frontend-${engine}-`));
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    const vite: ViteDevServer = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    cleanups.push(() => vite.close());
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owned frontend port");
    const executable =
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser =
      engine === "webkit"
        ? await webkit.launch()
        : await chromium.launch({
            ...(executable === undefined ? {} : { executablePath: executable }),
            args: ["--no-sandbox"],
          });
    cleanups.push(() => browser.close());
    const page = await browser.newPage(options.page);
    return {
      browser,
      page,
      origin: `http://127.0.0.1:${address.port}`,
      cleanup(task) {
        cleanups.push(task);
      },
    };
  } catch (primary) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([primary, cleanupError], "frontend startup and cleanup failed", {
        cause: primary,
      });
    }
    throw primary;
  }
}
