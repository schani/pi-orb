import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { createNativeMcpFetch } from "./native.ts";
import { McpCredentialResolver } from "./oauth.ts";

const config = {
  name: "fixture",
  description: "Fixture",
  url: "https://fixture.example/mcp",
  headers: {},
  oauth: { id: "10000000-0000-4000-8000-000000000001" },
} as const;

it("late broker resolution after abort never sends a native request", async () => {
  await runDst({ name: "native-mcp-aborted-broker", iterations: 40 }, async (sim) => {
    const run = await sim.runTasks([
      {
        name: "request",
        f: async (actor) => {
          const controller = new AbortController();
          let entered!: () => void;
          const waiting = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let release!: () => void;
          const blocked = new Promise<void>((resolve) => {
            release = resolve;
          });
          let sends = 0;
          const resolver = new McpCredentialResolver({
            request: async () => {
              entered();
              await blocked;
              return ok({
                accessToken: "private-token",
                generation: 1,
                expiresAt: actor.wallNow() + 100_000,
              });
            },
          });
          const request = createNativeMcpFetch({
            config,
            headers: {},
            resolver,
            task: actor,
            fetcher: async () => {
              sends++;
              return new Response("accepted");
            },
          });
          const result = request(config.url, { signal: controller.signal }).then(
            () => "sent",
            () => "cancelled",
          );
          await waiting;
          controller.abort();
          release();
          expect(await result).toBe("cancelled");
          expect(sends).toBe(0);
        },
      },
    ]);
    expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
  });
});
