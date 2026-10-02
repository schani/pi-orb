import { expect, type Page } from "@playwright/test";

/** Wait for the fixture's visible image content before measuring scroll or layout. */
export async function waitForFixtureMedia(page: Page): Promise<void> {
  await expect(page.locator(".tool-image-activity .tool-image-thumbnail")).toHaveCount(5);
  await expect(page.locator(".msg-image")).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator(".tool-image-activity .tool-image-thumbnail, .msg-image").evaluateAll(
        (images) =>
          images.length === 6 &&
          images.every((element) => {
            const image = element as typeof element & { complete: boolean; naturalWidth: number };
            return (
              image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0
            );
          }),
      ),
    )
    .toBe(true);
}
