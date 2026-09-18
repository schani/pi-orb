import type { Page } from "@playwright/test";

export async function gotoFrontendFixture(page: Page, url: string): Promise<void> {
  const projects = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "GET" && new URL(response.url()).pathname === "/api/v1/projects";
  });
  const [, response] = await Promise.all([page.goto(url), projects]);
  if (!response.ok())
    throw new Error(`Initial project fixture request failed: ${response.status()}`);
}
