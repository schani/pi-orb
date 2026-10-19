import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("browser resolution prefers the configured path, system Chromium, then Playwright", async () => {
  const { chromiumExecutable } = await import("./browser.ts");
  assert.equal(
    chromiumExecutable("/custom/chromium", () => true),
    "/custom/chromium",
  );
  assert.equal(
    chromiumExecutable("/custom/chromium", () => false),
    "/custom/chromium",
  );
  assert.equal(
    chromiumExecutable(undefined, () => true),
    "/usr/bin/chromium",
  );
  assert.equal(
    chromiumExecutable(undefined, () => false),
    undefined,
  );
  const smoke = await readFile(new URL("./smoke.test.mjs", import.meta.url), "utf8");
  assert.equal(
    smoke.match(/executablePath: chromiumExecutable\(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE\)/g)
      ?.length,
    2,
  );
});

test("existing CI runs prompt contracts and one sequential browser smoke", async () => {
  const root = new URL("../../", import.meta.url);
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.equal(ci.match(/npm run test:prompts/g)?.length, 1);
  assert.match(ci, /npx vitest run[^\n]*&& npm run test:prompts && npm run test:infra/);
  const e2e = await readFile(new URL(".github/workflows/e2e.yml", root), "utf8");
  assert.equal(e2e.match(/node --test scripts\/prompt-browser\/smoke\.test\.mjs/g)?.length, 1);
  assert.match(
    e2e,
    /- name: Test prompt browser\n\s+if: matrix\.shard == 1\n\s+run: node --test scripts\/prompt-browser\/smoke\.test\.mjs\n/,
  );
  assert.ok(
    e2e.indexOf("run: npm run test:e2e:install") < e2e.indexOf("- name: Test prompt browser"),
  );
  assert.ok(
    e2e.indexOf("- name: Test prompt browser") < e2e.indexOf("- name: Build E2E runtime image"),
  );
});
