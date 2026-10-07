import type { Page } from "@playwright/test";

export async function closeRoutedPage(page: Pick<Page, "unrouteAll" | "close">) {
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
}
