import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { captureColdNavigation, observeColdNavigation } from "./cold-navigation-evidence.ts";

it("distinguishes pending headers, unfinished bodies and failures without recording secrets", () => {
  const browser = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: () => "http://user:password@fixture.test/orbs/child?token=secret#private",
  });
  const evidence = observeColdNavigation(page as unknown as Page);
  const request = (path: string) =>
    ({
      url: () => `http://user:password@fixture.test${path}?token=secret`,
      method: () => "GET",
      headers: () => ({ authorization: "secret" }),
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
    }) as unknown as Request;
  const metadata = request("/api/v1/orbs/child");
  const history = request("/api/v1/orbs/child/history");
  const projects = request("/api/v1/projects");
  const privateRequest = request("/api/v1/credentials/private");
  for (const req of [metadata, history, projects, privateRequest]) page.emit("request", req);
  page.emit("response", { request: () => history, status: () => 200 });
  page.emit("requestfailed", projects);
  evidence.stage("history", "upstream-body", { records: 22, marker: true }, history);
  const snapshot = evidence.snapshot();
  expect(snapshot.interceptions[0]?.requestId).toBe(snapshot.requests[1]?.id);
  expect(snapshot.requests.map(({ stage }) => stage)).toEqual(["request", "headers", "failed"]);
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|password|private|authorization/);
  page.emit("requestfinished", history);
  expect(evidence.snapshot().requests[1]?.stage).toBe("body-finished");
  evidence.dispose();
  expect(page.eventNames()).toEqual([]);
  expect(browser.eventNames()).toEqual([]);
});

it("bounds observations and records browser faults independently", () => {
  const browser = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: () => "about:blank",
  });
  const evidence = observeColdNavigation(page as unknown as Page);
  page.emit("crash");
  browser.emit("disconnected");
  page.emit("pageerror", new Error("private model content"));
  for (let i = 0; i < 100; i++) evidence.stage("history", "fulfilled");
  expect(evidence.snapshot()).toMatchObject({ crashes: 1, disconnections: 1, pageErrors: 1 });
  expect(evidence.snapshot().interceptions.length).toBeLessThanOrEqual(80);
  expect(JSON.stringify(evidence.snapshot())).not.toContain("private model content");
  evidence.dispose();
});

it("freezes first-assertion evidence before browser round trips and masks screenshot contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cold-navigation-evidence-"));
  const browser = new EventEmitter();
  const screenshot = vi.fn(async () => Buffer.alloc(0));
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: () => "http://fixture.test/orbs/child",
    locator: (selector: string) => selector,
    evaluate: async () => {
      expect(JSON.parse(readFileSync(join(directory, "browser.json"), "utf8")).pageErrors).toBe(0);
      page.emit("pageerror", new Error("later fault"));
      return { readyState: "complete", mainBusy: "true", mainChildren: 0 };
    },
    screenshot,
  });
  const evidence = observeColdNavigation(page as unknown as Page);
  try {
    const result = await captureColdNavigation(page as unknown as Page, evidence, directory);
    expect(result.isOk()).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, "browser.json"), "utf8")).pageErrors).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "dom.json"), "utf8"))).toMatchObject({
      mainChildren: 0,
    });
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ mask: [".orb-main, .orb-index, input, textarea"] }),
    );
  } finally {
    evidence.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves structural evidence and the assertion error when a screenshot rejects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cold-navigation-evidence-"));
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => null }),
    url: () => "http://fixture.test/orbs/child",
    locator: (selector: string) => selector,
    evaluate: async () => ({ readyState: "complete", mainBusy: "true", mainChildren: 0 }),
    screenshot: async () => {
      throw new Error("screenshot unavailable");
    },
  });
  const evidence = observeColdNavigation(page as unknown as Page);
  const original = new Error("original visibility assertion");
  try {
    const captureAndRethrow = async () => {
      const captured = await captureColdNavigation(page as unknown as Page, evidence, directory);
      expect(captured.isOk()).toBe(true);
      if (captured.isOk())
        expect(captured.value).toMatchObject({
          structural: { mainChildren: 0 },
          screenshotCaptured: false,
        });
      throw original;
    };
    await expect(captureAndRethrow()).rejects.toBe(original);
  } finally {
    evidence.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
