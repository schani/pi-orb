import type { ClaudeAuthView } from "@pi-orb/protocol";
import type { Page } from "@playwright/test";

/** Public-contract fixture only: no CLI, OAuth exchange or inference. */
export async function mockClaudeOwnerConnection(page: Page) {
  let view: ClaudeAuthView = { status: "disconnected" };
  const actions: { action: string; body: unknown }[] = [];
  const responses: ClaudeAuthView[] = [];
  await page
    .context()
    .route("https://claude.ai/oauth/authorize?fixture=1", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Synthetic consent</p>" }),
    );
  await page.route("**/api/v1/claude/auth{,/**}", async (route) => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split("/")[5] ?? "view";
    if (request.method() === "POST") {
      actions.push({ action, body: request.postDataJSON() });
      if (action === "connect") {
        view = {
          status: "connecting",
          challenge: { url: "https://claude.ai/oauth/authorize?fixture=1", needsCode: true },
        };
      } else if (action === "code") {
        view = { status: "connected", generation: 1 };
      } else if (action === "cancel" || action === "disconnect") {
        view = { status: "disconnected" };
      }
    }
    responses.push(structuredClone(view));
    await route.fulfill({ json: view });
  });
  return { actions, responses };
}
