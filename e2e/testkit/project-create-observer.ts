import type { BrowserContext, Request } from "@playwright/test";

export function observeProjectCreates(
  context: Pick<BrowserContext, "on" | "off">,
  posts: Record<string, unknown>[],
): () => void {
  // Count requests without intercepting traffic.
  const requested = (request: Request) => {
    if (
      request.method() === "POST" &&
      /^\/api\/v1\/projects\/[^/]+\/orbs$/.test(new URL(request.url()).pathname)
    )
      posts.push(request.postDataJSON());
  };
  context.on("request", requested);
  return () => {
    context.off("request", requested);
  };
}
