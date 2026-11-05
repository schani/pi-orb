import { createHash, randomUUID } from "node:crypto";
import { type Browser, chromium, type Page } from "@playwright/test";
import { it as baseIt, expect } from "vitest";
import { ACCESS_TOKEN_HEADER } from "../apps/control-plane/src/domain/access-token.ts";
import { makeOrbRow, makeProjectRow } from "../apps/control-plane/src/testkit/fixtures.ts";
import { docker } from "./harness.ts";
import { startPreviewComposition } from "./testkit/preview-composition.ts";
import { startPreviewDockerRuntime } from "./testkit/preview-docker.ts";

const it = baseIt.skipIf(process.env["PI_ORB_E2E_BACKEND"] === "process");

async function gotoFile(page: Page, url: string) {
  // Fresh origins pass through an app-host HTML form before the final file response.
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === url &&
        response.request().isNavigationRequest() &&
        response.frame() === page.mainFrame() &&
        (response.status() < 300 || response.status() >= 400),
    ),
    page.goto(url),
  ]);
  await page.waitForURL((target) => target.href === url);
  return response;
}

for (const execution of [true, false]) {
  it(`${execution ? "central-Pi execution" : "Claude host"}: reads registration-free live files through owner login and cross-project id-tokens`, async () => {
    const runtime = await startPreviewDockerRuntime({ execution });
    let fixture: Awaited<ReturnType<typeof startPreviewComposition>> | undefined;
    let browser: Browser | undefined;
    try {
      const missingOrbId = randomUUID();
      fixture = await startPreviewComposition(runtime.ports, runtime, {
        files: true,
        missingOrbId,
      });
      browser = await chromium.launch({ proxy: { server: fixture.proxyUrl } });
      const origin = fixture.liveFilesOrigin;
      if (!origin || !fixture.missingFilesOrigin) throw new Error("Live file origins missing");
      const path = "/workspace/Review # notes %.html";
      const url = `${origin}/workspace/Review%20%23%20notes%20%25.html`;
      const html = '<body><h1>Live report</h1><script src="./asset.js"></script></body>';
      await docker([
        "exec",
        runtime.name,
        "node",
        "-e",
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(html)}); fs.writeFileSync("/workspace/asset.js", 'document.body.dataset.asset = "loaded"');`,
      ]);

      const sourceId = randomUUID();
      const sourceToken = randomUUID();
      const sourceProject = makeProjectRow(randomUUID());
      const target = fixture.h.store.orbSnapshot(runtime.orbId);
      if (!target?.runtimeTokenHash) throw new Error("Target runtime identity missing");
      const targetProject = fixture.h.store.projectSnapshot(target.projectId);
      if (!targetProject) throw new Error("Target project missing");
      fixture.h.store.seedProject({ ...targetProject, ownerUserId: "durable-alice" });
      fixture.h.store.seedProject({ ...sourceProject, ownerUserId: "durable-alice" });
      fixture.h.store.seedOrb(
        makeOrbRow(sourceId, sourceProject.id, "running", {
          runtimeTokenHash: createHash("sha256").update(sourceToken).digest("hex"),
        }),
      );
      const token = (await fixture.idToken(sourceToken))._unsafeUnwrap();
      const before = fixture.h.store.orbSnapshot(runtime.orbId);
      const machine = await browser.newContext({ ignoreHTTPSErrors: true });
      expect((await machine.request.get(url)).status()).toBe(401);
      const scripted = await machine.request.get(url, {
        headers: { [ACCESS_TOKEN_HEADER]: token },
      });
      expect(scripted.status()).toBe(200);
      expect(await scripted.text()).toBe(html);
      const owner = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await owner.newPage();
      await page.goto(`${fixture.appOrigin}/auth/login`);
      await page.waitForURL(`${fixture.appOrigin}/`);
      expect((await gotoFile(page, url)).status()).toBe(200);
      expect(page.url()).toBe(url);
      await page.waitForFunction('document.body.dataset.asset === "loaded"');
      // Live URLs change with the guest file, not a publication or registration.
      await docker([
        "exec",
        runtime.name,
        "node",
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(path)}, "<h1>Updated report</h1>")`,
      ]);
      expect(await (await owner.request.get(url)).text()).toBe("<h1>Updated report</h1>");
      const missing = `${origin}/workspace/missing.html`;
      expect((await gotoFile(page, missing)).status()).toBe(404);
      expect(page.url()).toBe(missing);
      expect(await page.locator("body").textContent()).toMatch(/file.*doesn.t exist/i);
      expect(await page.locator("a").getAttribute("href")).toBe(fixture.appOrigin);
      const missingOrbUrl = `${fixture.missingFilesOrigin}/workspace/report.html`;
      expect((await gotoFile(page, missingOrbUrl)).status()).toBe(404);
      expect(page.url()).toBe(missingOrbUrl);
      expect(await page.locator("body").textContent()).toMatch(/orb.*doesn.t exist/i);
      expect(await page.locator("a").getAttribute("href")).toBe(fixture.appOrigin);

      fixture.account("coworker");
      const coworker = await browser.newContext({ ignoreHTTPSErrors: true });
      const coworkerPage = await coworker.newPage();
      await coworkerPage.goto(`${fixture.appOrigin}/auth/login`);
      await coworkerPage.waitForURL(`${fixture.appOrigin}/`);
      expect((await gotoFile(coworkerPage, url)).status()).toBe(403);
      expect(fixture.h.store.orbSnapshot(runtime.orbId)).toEqual(before);
      expect(
        (
          await fixture.h.store.listPreviews(fixture.task, {
            orbId: runtime.orbId,
            caller: {
              runtimeTokenHash: target.runtimeTokenHash,
              hostIncarnation: target.hostIncarnation,
            },
          })
        )._unsafeUnwrap(),
      ).toEqual([]);
      expect((await runtime.info()).active).toBe(false);
      const stopping = (await fixture.stopOrb())._unsafeUnwrap();
      expect(stopping.state).toBe("stopping");
      const observed = fixture.observed();
      expect((await owner.request.get(url)).status()).toBe(503);
      expect(fixture.observed()).toBe(observed);
      expect(fixture.h.store.orbSnapshot(runtime.orbId)?.state).toBe("stopping");
    } finally {
      await browser?.close();
      await fixture?.close();
      await runtime.close();
    }
  });
}
