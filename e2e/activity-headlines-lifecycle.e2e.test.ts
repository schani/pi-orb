import { type Browser, chromium, type Page, webkit } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.each([
  { name: "chromium", engine: chromium },
  { name: "webkit", engine: webkit },
])("$name", ({ engine }) => {
  let browser: Browser;
  let script: string;
  beforeAll(async () => {
    browser = await engine.launch();
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import {ToolActivity} from './apps/web/src/components/ToolActivity.tsx';
        import {HeadlineSlots} from './apps/web/src/lib/use-activity-headline.tsx';
        import {HeadlineLimiter} from './apps/web/src/lib/activity-headline.ts';
        const observers = [];
        window.IntersectionObserver = class {
          constructor(callback) { this.callback = callback; observers.push(this); }
          observe(node) { this.node = node; }
          disconnect() { this.node = null; }
        };
        const requests = [];
        window.fetch = (url, options) => new Promise(resolve => {
          requests.push({url, signal: options.signal, resolve});
        });
        const slots = new HeadlineLimiter();
        const root = createRoot(document.getElementById('root'));
        const call = n => ({callRecordId: 'record'+n, call: {
          type:'tool_call', callId:'call'+n, name:'codemode', detailKey:'key'+n, headline:null
        }});
        window.fixture = {
          render(count, sessionId = 'session', outcome = false) {
            const persisted = Array.from({length:count}, (_, n) => call(n));
            if(outcome) Object.assign(persisted[0], {resultRecordId:'outcome', result:{
              type:'tool_result', callId:'call0', detailKey:'result', headline:null,
              isError:false, hasImages:false
            }});
            flushSync(() => root.render(<HeadlineSlots.Provider value={slots}>
              <ToolActivity persisted={persisted} detailContext={{orbId:'orb',sessionId}} />
            </HeadlineSlots.Provider>));
          },
          visibility(state) {
            Object.defineProperty(document, 'visibilityState', {configurable:true, value:state});
            document.dispatchEvent(new Event('visibilitychange'));
          },
          retryAndHide(selector) {
            flushSync(() => document.querySelector('.activity-headline-retry').click());
            this.visibility('hidden');
            document.querySelector(selector).style.display = 'none';
          },
          see(selector) {
            const node = document.querySelector(selector);
            for(const observer of observers) if(observer.node === node) observer.callback([
              {target:node,isIntersecting:true,intersectionRect:{width:10,height:10}}
            ]);
          },
          remember(selector) {
            const node = document.querySelector(selector);
            const observer = observers.find(o => o.node === node);
            this.late = () => observer?.callback([
              {target:node,isIntersecting:true,intersectionRect:{width:10,height:10}}
            ]);
          },
          settle(index, failed = false) {
            requests[index].resolve(new Response(JSON.stringify(failed ? {error:'unavailable'} :
              {headline:'Ready first'}), {status:failed ? 503 : 200}));
          },
          snapshot() { return requests.map(r => ({url:r.url,aborted:r.signal.aborted})); },
          block() { const releases=[]; slots.enqueue(r=>releases.push(r)); slots.enqueue(r=>releases.push(r)); this.release=()=>releases[0](); },
          unmount() { flushSync(()=>root.unmount()); }
        };
      `,
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    script = bundle.outputFiles[0]?.text ?? "";
  });
  afterAll(async () => browser?.close());

  async function fixture(run: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      await run(page);
    } finally {
      await page.close();
    }
  }
  // Browser tasks are explicit gates; no sleeps or transport timing assumptions.
  async function command(page: Page, code: string) {
    await page.evaluate(code);
  }
  const category = ".tool-activity-category > summary";
  const firstChild = ".tool-activity-call:first-child > summary";
  async function requests(page: Page) {
    return page.evaluate("fixture.snapshot()") as Promise<Array<{ url: string; aborted: boolean }>>;
  }

  it.each(["failed", "ready", "pending", "queued"] as const)(
    "preserves the first %s source through category growth",
    async (state) =>
      fixture(async (page) => {
        await command(
          page,
          `fixture.render(1); ${state === "queued" ? "fixture.block();" : ""} fixture.see('${category}')`,
        );
        expect(await page.locator(category).getByText("Summary unavailable.").count()).toBe(0);
        expect(await page.locator(category).getByRole("button", { name: "Retry" }).count()).toBe(0);
        if (state === "failed" || state === "ready") {
          await command(page, `fixture.settle(0, ${state === "failed"})`);
          await page
            .locator(category)
            .getByText(state === "failed" ? "Summary unavailable." : "Ready first")
            .waitFor();
        }
        await command(page, "fixture.render(2)");
        expect(await requests(page)).toHaveLength(state === "queued" ? 0 : 1);
        if (state !== "queued") expect((await requests(page))[0]?.aborted).toBe(false);
        await page.locator(".tool-activity-category").evaluate((node) => {
          (node as unknown as { open: boolean }).open = true;
        });
        await command(
          page,
          state === "queued" ? "fixture.release()" : `fixture.see('${firstChild}')`,
        );
        expect(await requests(page)).toHaveLength(1);
        expect((await requests(page))[0]?.aborted).toBe(false);
        if (state === "failed" || state === "ready") {
          expect(await page.locator(firstChild).textContent()).toContain(
            state === "failed" ? "Summary unavailable." : "Ready first",
          );
        } else {
          await command(page, "fixture.settle(0)");
          await page.locator(firstChild).getByText("Ready first").waitFor();
        }
        if (state === "failed") {
          expect(
            await page
              .locator(firstChild)
              .getByText("Summary unavailable.", { exact: true })
              .getAttribute("class"),
          ).toContain("error-text");
          expect(await page.getByRole("button", { name: "Retry" }).getAttribute("class")).toContain(
            "error-text",
          );
          await command(page, "fixture.render(2)");
          expect(await requests(page)).toHaveLength(1);
          await page.getByRole("button", { name: "Retry" }).click();
          await command(page, `fixture.see('${firstChild}')`);
          expect(await requests(page)).toHaveLength(2);
          expect(await page.locator(firstChild).locator(".error-text").count()).toBe(0);
          expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
        }
      }),
  );

  it("does not qualify an unseen first child from the still-visible category header", async () =>
    fixture(async (page) => {
      await command(page, `fixture.render(1); fixture.remember('${category}')`);
      await command(page, `fixture.render(2); fixture.late(); fixture.see('${category}')`);
      expect(await requests(page)).toHaveLength(0);
      await page.locator(".tool-activity-category").evaluate((node) => {
        (node as unknown as { open: boolean }).open = true;
      });
      await command(page, `fixture.see('${firstChild}')`);
      expect(await requests(page)).toHaveLength(1);
    }));

  it.each(["hidden mount", "same-node crop"] as const)(
    "requires a fresh visible observation after %s",
    async (scenario) =>
      fixture(async (page) => {
        await command(
          page,
          `${scenario === "hidden mount" ? "fixture.visibility('hidden');" : ""}
          fixture.render(1); fixture.remember('${category}');
          ${scenario === "same-node crop" ? "fixture.visibility('hidden');" : ""}
          fixture.late(); document.querySelector('${category}').style.display='none';`,
        );
        expect(await requests(page)).toHaveLength(0);
        expect(await page.locator(category).evaluate((node) => node.getClientRects().length)).toBe(
          0,
        );
        await command(page, "fixture.visibility('visible')");
        expect(await requests(page)).toHaveLength(0);
        await command(page, "fixture.late()");
        expect(await requests(page)).toHaveLength(0);
        await command(
          page,
          `document.querySelector('${category}').style.display=''; fixture.late()`,
        );
        expect(await requests(page)).toHaveLength(0);
        await command(page, `fixture.see('${category}')`);
        expect(await requests(page)).toHaveLength(1);
      }),
  );

  it("retries an already-qualified source without another visibility lease", async () =>
    fixture(async (page) => {
      await command(page, `fixture.render(1); fixture.see('${category}'); fixture.settle(0, true)`);
      await page.getByRole("button", { name: "Retry" }).waitFor();
      await command(page, `fixture.retryAndHide('${category}')`);
      expect(await requests(page)).toHaveLength(2);
      expect((await requests(page))[1]?.aborted).toBe(false);
      await command(page, "fixture.settle(1)");
      await page.locator(category).getByText("Ready first").waitFor({ state: "attached" });
    }));

  it.each(["active", "queued"] as const)(
    "lets an already-qualified %s request finish hidden and cropped",
    async (state) =>
      fixture(async (page) => {
        await command(
          page,
          `fixture.render(1); ${state === "queued" ? "fixture.block();" : ""}
          fixture.see('${category}'); fixture.visibility('hidden');
          document.querySelector('${category}').style.display='none';
          ${state === "queued" ? "fixture.release();" : ""}`,
        );
        expect(await requests(page)).toHaveLength(1);
        expect((await requests(page))[0]?.aborted).toBe(false);
        await command(page, "fixture.settle(0)");
        await page.locator(category).getByText("Ready first").waitFor({ state: "attached" });
      }),
  );

  it("does not retain qualification after a source changes and reverts", async () =>
    fixture(async (page) => {
      await command(
        page,
        `fixture.render(1); fixture.see('${category}'); fixture.visibility('hidden')`,
      );
      await command(page, "fixture.render(1, 'other-session'); fixture.render(1)");
      expect(await requests(page)).toHaveLength(1);
      expect((await requests(page))[0]?.aborted).toBe(true);
      await command(page, "fixture.visibility('visible')");
      expect(await requests(page)).toHaveLength(1);
      await command(page, `fixture.see('${category}')`);
      expect(await requests(page)).toHaveLength(2);
    }));

  it.each(["outcome", "session", "unmount"] as const)(
    "cancels on true %s changes and ignores stale completion",
    async (change) =>
      fixture(async (page) => {
        await command(page, `fixture.render(1); fixture.see('${category}'); fixture.render(2)`);
        await command(
          page,
          change === "unmount"
            ? "fixture.unmount()"
            : `fixture.render(2, '${change === "session" ? "new-session" : "session"}', ${change === "outcome"})`,
        );
        expect((await requests(page))[0]?.aborted).toBe(true);
        await command(page, "fixture.settle(0)");
        expect(await page.locator("#root").textContent()).not.toContain("Ready first");
      }),
  );
});
