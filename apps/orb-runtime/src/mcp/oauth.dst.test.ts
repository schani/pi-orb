import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { McpCredentialResolver } from "./oauth.ts";
import { mcpError } from "./service.ts";

it("cannot regress its cached generation when concurrent token responses arrive out of order", async () => {
  await runDst({ name: "mcp-token-response-order", iterations: 50 }, async (sim) => {
    let calls = 0;
    let newerDelivered = false;
    const resolver = new McpCredentialResolver({
      request: async (task) => {
        const call = ++calls;
        if (call === 1)
          while (!newerDelivered) await task.sleep(1, "wait for newer response adoption");
        return ok({
          accessToken: `access-${call}`,
          generation: call,
          expiresAt: task.wallNow() + 3_600_000,
        });
      },
    });
    const run = await sim.runTasks(
      ["post", "stream"].map((name) => ({
        name,
        f: async (task) => {
          const token = await resolver.resolve(task, new AbortController().signal);
          expect(token._unsafeUnwrap().generation).toBe(2);
          newerDelivered = true;
        },
      })),
    );
    expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
  });
});

it("refreshes request-time credentials, bounds rejected-generation recovery, and adopts reauthorization", async () => {
  await runDst({ name: "mcp-token-cache", iterations: 40 }, async (sim) => {
    const run = await sim.runTasks([
      {
        name: "runtime",
        f: async (task) => {
          let generation = 1;
          let requests = 0;
          let refreshes = 0;
          let unavailable = false;
          const resolver = new McpCredentialResolver({
            request: async (t, _signal, rejected) => {
              requests++;
              await t.checkpoint("broker:accepted");
              if (unavailable) return err(mcpError("unavailable", "Broker outage"));
              if (rejected === generation) {
                generation++;
                refreshes++;
              }
              return ok({
                accessToken: `access-${generation}`,
                generation,
                expiresAt: t.wallNow() + 60_000,
              });
            },
          });
          const signal = new AbortController().signal;
          expect((await resolver.resolve(task, signal))._unsafeUnwrap().generation).toBe(1);
          expect((await resolver.resolve(task, signal)).isOk()).toBe(true);
          expect(requests).toBe(1);
          resolver.rejected(1);
          expect((await resolver.resolve(task, signal))._unsafeUnwrap().generation).toBe(2);
          resolver.rejected(2);
          expect((await resolver.resolve(task, signal)).isErr()).toBe(true);
          expect(refreshes).toBe(1);
          generation = 3;
          expect((await resolver.resolve(task, signal))._unsafeUnwrap().generation).toBe(3);
          resolver.accepted();
          await task.sleep(60_000, "token expires on open connection");
          unavailable = true;
          expect((await resolver.resolve(task, signal)).isErr()).toBe(true);
          unavailable = false;
          expect((await resolver.resolve(task, signal)).isOk()).toBe(true);
          const abort = new AbortController();
          abort.abort();
          expect((await resolver.resolve(task, abort.signal)).isErr()).toBe(true);
        },
      },
    ]);
    expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
  });
});
