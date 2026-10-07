import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { assert, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

// Component fixture: only public display DTOs and an owned in-memory transcript cache.
const fixture = `<!doctype html><link rel="icon" href="data:,"><div id="root"></div><button id="reconnect">reconnect</button>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ToolActivity } from '/src/components/ToolActivity.tsx';
import { TranscriptCache } from '/src/lib/transcript-cache.ts';
import '/src/styles.css';
const persisted = Array.from({length:9}, (_,i) => ({
  callRecordId:'call-'+i,
  call:{type:'tool_call',callId:''+i,name:'Agent',detailKey:'call-'+i+':0',headline:'worker '+i},
  resultRecordId:'result-'+i,
  result:{type:'tool_result',callId:''+i,detailKey:'result-'+i+':0',hasImages:false,asyncLaunch:true},
}));
const cache = new TranscriptCache();
const owner = cache.acquire('fixture','project');
const records = new Map();
for (const pair of persisted) {
  for (const [id,block] of [[pair.callRecordId,pair.call],[pair.resultRecordId,pair.result]])
    records.set(id,{id,parentId:null,timestamp:'t',type:'message',content:[block]});
}
owner.publish({sessionId:'session',records,afterRecordId:'result-8',headId:'result-8'});
for (const pair of persisted) {
  owner.publishDetail({orbId:'fixture',sessionId:'session',recordId:pair.callRecordId,detailKey:pair.call.detailKey,body:{type:'tool_call',arguments:{description:pair.call.headline}}});
  owner.publishDetail({orbId:'fixture',sessionId:'session',recordId:pair.resultRecordId,detailKey:pair.result.detailKey,body:{type:'tool_result',content:[{type:'text',text:'admission receipt'}]}});
}
const context = {orbId:'fixture',sessionId:'session',connected:false,operationId:null,cache,getOwner:()=>owner,livePending:new Map(),committedPending:new Map(),imagePending:new Map()};
let root = createRoot(document.getElementById('root'));
const render = calls => root.render(React.createElement(ToolActivity,{persisted:calls,detailContext:context}));
render(persisted);
document.getElementById('reconnect').onclick = () => {
  root.unmount(); root = createRoot(document.getElementById('root'));
  render(JSON.parse(JSON.stringify(persisted)));
};
</script>`;

it.each(["chromium", "webkit"] as const)(
  "%s: background receipts stay started through disclosure and cached reconnect",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "pi-orb-admission-"));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "admission-fixture",
          configureServer(server) {
            server.middlewares.use("/admission-fixture", (_request, response, next) => {
              void server
                .transformIndexHtml("/admission-fixture", fixture)
                .then((html) => {
                  response.setHeader("Content-Type", "text/html");
                  response.end(html);
                })
                .catch(next);
            });
          },
        },
      ],
    });
    const executablePath =
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser =
      engine === "webkit"
        ? await webkit.launch()
        : await chromium.launch({
            ...(executablePath ? { executablePath } : {}),
            args: ["--no-sandbox"],
          });
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      assert(address && typeof address !== "string", "missing fixture address");
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("fixture pageerror", error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error") console.error("fixture console", message.text());
      });
      await page.goto(`http://127.0.0.1:${address.port}/admission-fixture`);
      const category = page.locator(".tool-activity-category");
      await expect(category.locator(":scope > summary")).toContainText("9 started");
      for (let replay = 0; replay < 2; replay++) {
        await category.locator(":scope > summary").click();
        await expect(page.locator(".tool-call-status")).toHaveText(Array(9).fill("started"));
        const call = page.locator(".tool-activity-call").first();
        await call.locator("summary").click();
        await expect(call.locator(".tool-call-output")).toHaveText("admission receipt");
        await expect(call.locator(".tool-input")).toContainText("worker 0");
        await expect(page.locator(".tool-call-running")).toHaveCount(0);
        await page.getByRole("button", { name: "reconnect", exact: true }).click();
        await expect(category).not.toHaveAttribute("open");
        await expect(category.locator(":scope > summary")).toContainText("9 started");
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
