import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s submits GitHub shorthand through the project form and reads canonical persistence",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "repository-shorthand-frontend-"));
    const vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const context = await browser.newContext();
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const externalRequests: string[] = [];
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          externalRequests.push(route.request().url());
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      const posts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects")
          posts.push(request.postData() ?? "");
      });
      const form = page.locator(".new-project form");
      const repository = form.getByLabel("repository URL", { exact: true });
      await gotoFrontendFixture(page, origin, repository);
      await check(repository).toHaveAttribute("type", "text");
      await form.getByLabel("project name", { exact: true }).fill("Shorthand browser");
      await repository.fill("schani/pi-orb/extra");
      await form.getByRole("button", { name: "Create project", exact: true }).click();
      await check(form.locator(".banner-error")).toContainText("not a parseable absolute URL");
      check(posts).toEqual([]);

      await repository.fill("schani/pi-orb");
      check(
        await repository.evaluate((input) =>
          (input as unknown as { checkValidity(): boolean }).checkValidity(),
        ),
      ).toBe(true);
      const createdResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/projects",
      );
      await form.getByRole("button", { name: "Create project", exact: true }).click();
      const response = await createdResponse;
      check(response.status()).toBe(201);
      check(response.request().postDataJSON()).toMatchObject({ repositoryUrl: "schani/pi-orb" });
      const created = await response.json();
      check(created.repositoryUrl).toBe("https://github.com/schani/pi-orb");
      check(posts).toHaveLength(1);
      const read = await page.request.get(`${origin}/api/v1/projects/${created.id}`);
      check(read.status()).toBe(200);
      check((await read.json()).repositoryUrl).toBe("https://github.com/schani/pi-orb");
      await check(repository).toHaveValue("");
      await page.getByRole("button", { name: "Configure Shorthand browser", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "General", exact: true }).click();
      const savedRepository = dialog.getByLabel("Repository URL", { exact: true });
      await check(savedRepository).toHaveValue("https://github.com/schani/pi-orb");
      check(externalRequests).toEqual([]);
    } finally {
      await context.close();
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
