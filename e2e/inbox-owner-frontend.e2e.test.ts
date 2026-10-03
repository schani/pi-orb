import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

const harnessSource = `
import * as OwnerReact from "react";
import { createRoot as createOwnerRoot } from "react-dom/client";
import { createInboxPoller as createOwnerPoller } from "./lib/inbox-poller.ts";
import { ok as ownerOk } from "neverthrow";
globalThis.inboxOwnerRepro = (() => {
  let rendered = [], setter, suspended = false, blocked = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const row = { id: "m1", orbId: "orb", content: [{ type: "text", text: "owned pending message" }], status: "queued", createdAt: "now", updatedAt: "now" };
  const calls = [];
  const poller = createOwnerPoller(async (after, tracked) => {
    calls.push({ after, tracked });
    return ownerOk({ items: after === 0 ? [row] : [], updates: [], cursor: 1 });
  });
  function View() {
    const [rows, setRows] = OwnerReact.useState([]);
    setter = setRows;
    if (blocked && rows.length > 0) { suspended = true; throw gate; }
    rendered = rows;
    return OwnerReact.createElement("div", { id: "inbox-owner-view" }, rows.map(row => row.id).join(","));
  }
  return {
    mount() {
      const host = document.createElement("div");
      host.id = "inbox-owner-host";
      document.body.append(host);
      createOwnerRoot(host).render(OwnerReact.createElement(OwnerReact.Suspense, { fallback: "held" }, OwnerReact.createElement(View)));
    },
    ready: () => setter !== undefined,
    suspended: () => suspended,
    poll: () => poller.poll(() => true, rows => OwnerReact.startTransition(() => setter(rows))),
    summary: () => ({ rendered: rendered.map(row => row.id), owned: poller.rows().map(row => row.id), cursor: poller.cursor(), calls }),
    release() { blocked = false; release(); },
  };
})();
`;

type OwnerHarness = {
  mount(): void;
  ready(): boolean;
  suspended(): boolean;
  poll(): Promise<unknown>;
  summary(): {
    rendered: string[];
    owned: string[];
    cursor: number;
    calls: { after: number; tracked: string[] }[];
  };
  release(): void;
};

it.each(["chromium", "webkit"] as const)(
  "%s: suspended React render cannot drop newly polled pending rows",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "inbox-owner-repro",
          enforce: "pre",
          transform(code, id) {
            if (id.endsWith("/src/main.tsx")) return `${code}\n${harnessSource}`;
            return undefined;
          },
        },
      ],
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owner fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await check
        .poll(() => page.evaluate(() => Reflect.has(globalThis, "inboxOwnerRepro")))
        .toBe(true);
      await page.evaluate(() =>
        (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).mount(),
      );
      await check
        .poll(() =>
          page.evaluate(() => (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).ready()),
        )
        .toBe(true);
      await page.evaluate(() =>
        (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).poll(),
      );
      await check
        .poll(() =>
          page.evaluate(() =>
            (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).suspended(),
          ),
        )
        .toBe(true);
      await page.evaluate(() =>
        (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).poll(),
      );
      check(
        await page.evaluate(() =>
          (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).summary(),
        ),
      ).toEqual({
        rendered: [],
        owned: ["m1"],
        cursor: 1,
        calls: [
          { after: 0, tracked: [] },
          { after: 1, tracked: ["m1"] },
        ],
      });
      await page.evaluate(() =>
        (Reflect.get(globalThis, "inboxOwnerRepro") as OwnerHarness).release(),
      );
      await check(page.locator("#inbox-owner-view")).toHaveText("m1");
    } finally {
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
