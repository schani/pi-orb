import { ResultAsync } from "neverthrow";
import type { ViteDevServer } from "vite";
import { expect } from "vitest";

/** Vite treats listen(0) as its default preview port. Bind the owned Node server instead. */
export async function listenFrontend(vite: Pick<ViteDevServer, "httpServer">): Promise<void> {
  const server = vite.httpServer;
  if (server === null) expect.fail("Frontend fixture requires an HTTP server");
  const result = await ResultAsync.fromPromise(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }),
    (cause) => ({
      type: "frontend_listen_failed" as const,
      message: cause instanceof Error ? cause.message : "Unknown listen failure",
    }),
  );
  // The Vitest setup contract reports adapter failure as an assertion, not domain control flow.
  expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
}
