import { existsSync } from "node:fs";
import { chromium, expect as expectPage } from "@playwright/test";
import { expect, it } from "vitest";

it("completion assertions tolerate the explicit history-before-retirement handoff", async () => {
  const executablePath =
    process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    // The reducer/HistoryView contract is covered in output-handoff.test.tsx.
    // Hold its two-copy intermediate DOM here to reproduce the selector failure
    // independently of model, transport, and React scheduling.
    await page.setContent("<p>MCP_CHECK_COMPLETE</p><p>MCP_CHECK_COMPLETE</p>");
    const completion = page.getByText("MCP_CHECK_COMPLETE", { exact: true });
    await expectPage(completion).toHaveCount(2);
    await expect(expectPage(completion).toBeVisible()).rejects.toThrow("strict mode violation");
    // The list assertion still rejects persistent duplicates, but as a retryable
    // count/text mismatch rather than a strict-selector error.
    await expect(
      expectPage(completion.filter({ visible: true })).toHaveText(["MCP_CHECK_COMPLETE"], {
        timeout: 1,
      }),
    ).rejects.not.toThrow("strict mode violation");
    await page.setContent("<p>MCP_CHECK_COMPLETE</p>");
    await expectPage(completion.filter({ visible: true })).toHaveText(["MCP_CHECK_COMPLETE"]);
  } finally {
    await browser.close();
  }
});
