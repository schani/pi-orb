import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  cleanup: undefined as (() => Promise<void>) | undefined,
  cache: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  listen: vi.fn(),
  serverClose: vi.fn(),
  launch: vi.fn(),
  browserClose: vi.fn(),
  page: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdtemp: f.cache, rm: f.remove }));
vi.mock("vite", () => ({ createServer: f.create }));
vi.mock("../frontend-listen.ts", () => ({ listenFrontend: f.listen }));
vi.mock("@playwright/test", () => ({
  chromium: { launch: f.launch },
  webkit: { launch: f.launch },
}));
vi.mock("vitest", async (original) => ({
  ...(await original<typeof import("vitest")>()),
  onTestFinished: (cleanup: () => Promise<void>) => {
    f.cleanup = cleanup;
  },
}));

import { createFrontendFixture } from "./frontend-owned.ts";

beforeEach(() => {
  vi.resetAllMocks();
  f.cleanup = undefined;
  f.cache.mockResolvedValue("/owned-cache");
  f.remove.mockResolvedValue(undefined);
  f.create.mockResolvedValue({
    close: f.serverClose,
    httpServer: { address: () => ({ port: 1234 }) },
  });
  f.listen.mockResolvedValue(undefined);
  f.serverClose.mockResolvedValue(undefined);
  f.launch.mockResolvedValue({ close: f.browserClose, newPage: f.page });
  f.browserClose.mockResolvedValue(undefined);
  f.page.mockResolvedValue({});
});

it.each(["create", "listen", "launch", "page"] as const)(
  "cleans partial startup at %s and preserves its error",
  async (stage) => {
    const primary = new Error(stage);
    f[stage].mockRejectedValue(primary);
    f.serverClose.mockRejectedValue(new Error("cleanup"));
    const started = createFrontendFixture("chromium");
    if (stage === "create") await expect(started).rejects.toBe(primary);
    else
      await expect(started).rejects.toMatchObject({
        cause: primary,
        errors: [primary, expect.any(AggregateError)],
      });
    expect(f.remove).toHaveBeenCalledWith("/owned-cache", { recursive: true, force: true });
    expect(f.serverClose).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
    expect(f.browserClose).toHaveBeenCalledTimes(stage === "page" ? 1 : 0);
    await f.cleanup?.();
  },
);

it("attempts every cleanup even when browser close rejects", async () => {
  const fixture = await createFrontendFixture("webkit", {
    page: { viewport: { width: 820, height: 900 } },
  });
  expect(fixture.origin).toBe("http://127.0.0.1:1234");
  expect(f.page).toHaveBeenCalledWith({ viewport: { width: 820, height: 900 } });
  f.browserClose.mockRejectedValue(new Error("browser"));
  await expect(f.cleanup?.()).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "browser" })],
  });
  expect(f.serverClose).toHaveBeenCalledOnce();
  expect(f.remove).toHaveBeenCalledOnce();
});
