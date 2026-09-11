import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../testkit/broker.ts";
import { runDst } from "../testkit/sim.ts";
import {
  McpOAuth,
  type McpOAuthBinding,
  type McpOAuthRow,
  type McpOAuthStore,
  oauthError,
  type StoredMcpOAuth,
} from "./mcp-oauth.ts";

const binding: McpOAuthBinding = { projectId: "p", id: "c", url: "https://mcp.example/mcp" };
function harness() {
  let row: McpOAuthRow | null = null;
  let active = true;
  let lostAck = false;
  let exchanges = 0;
  let refreshes = 0;
  let exchangeBarrier: ((task: SimulationTask) => Promise<void>) | null = null;
  let lostExchange = false;
  let refreshBarrier: ((task: SimulationTask) => Promise<void>) | null = null;
  let invalidRefresh = false;
  const edges: string[] = [];
  const store: McpOAuthStore = {
    read: async (task, b) => {
      await task.checkpoint("mcp:read");
      return active &&
        b.projectId === binding.projectId &&
        b.id === binding.id &&
        b.url === binding.url
        ? ok(row)
        : err(oauthError("not_found"));
    },
    cas: async (task, b, expected, next, edge) => {
      await task.checkpoint("mcp:before-cas");
      if (
        !active ||
        b.projectId !== binding.projectId ||
        b.id !== binding.id ||
        b.url !== binding.url
      )
        return err(oauthError("not_found"));
      if ((row?.rowVersion ?? null) !== expected) return err(oauthError("conflict"));
      row = { ...next, provider: b.id, rowVersion: (expected ?? 0) + 1 };
      if (edge && (edge !== "refresh_failed" || edges.at(-1) !== edge)) edges.push(edge);
      const committed = row;
      await task.checkpoint("mcp:after-cas");
      if (lostAck && edge === "connected") {
        lostAck = false;
        return err(oauthError("unavailable"));
      }
      return ok(committed);
    },
  };
  const secrets = new FakeSecretStore();
  const credential = (task: SimulationTask): StoredMcpOAuth => ({
    projectId: "p",
    connectionId: "c",
    oauth: {},
    access: "access",
    refresh: "refresh",
    accountId: "c",
    expiresAt: task.wallNow() + 3_600_000,
  });
  const make = () =>
    new McpOAuth(store, secrets, {
      prepare: async (task) => {
        await task.checkpoint("mcp:prepare");
        return ok({ url: "https://consent.example/", secret: credential(task) });
      },
      exchange: async (task) => {
        exchanges++;
        await task.checkpoint("mcp:code-consumed");
        if (exchangeBarrier) await exchangeBarrier(task);
        if (lostExchange) return err(oauthError("unavailable"));
        return ok(credential(task));
      },
      refresher: {
        refresh: (task, old) =>
          ResultAsync.fromSafePromise(
            (async () => {
              refreshes++;
              await task.checkpoint("mcp:refresh-accepted");
              if (refreshBarrier) await refreshBarrier(task);
              if (invalidRefresh)
                return err({ type: "invalid_grant" as const, message: "revoked" });
              return ok({
                ...old,
                access: `access-${refreshes}`,
                expiresAt: task.wallNow() + 3_600_000,
              });
            })(),
          ).andThen((r) => r),
      },
    });
  return {
    make,
    edges,
    secrets,
    pauseExchange: (barrier: (task: SimulationTask) => Promise<void>) => {
      exchangeBarrier = barrier;
    },
    loseExchange: () => {
      lostExchange = true;
    },
    pauseRefresh: (barrier: (task: SimulationTask) => Promise<void>) => {
      refreshBarrier = barrier;
    },
    invalidateRefresh: () => {
      invalidRefresh = true;
    },
    state: () => row,
    exchanges: () => exchanges,
    refreshes: () => refreshes,
    remove: () => {
      active = false;
    },
    loseAck: () => {
      lostAck = true;
    },
  };
}

describe("MCP OAuth composed DST", () => {
  it("a late invalid-grant response cannot clear a newer browser grant", async () => {
    await runDst(
      { name: "mcp-oauth-refresh-versus-login", iterations: 60, lateTimerProbability: 0 },
      async (sim) => {
        const h = harness();
        let ready = false;
        let refreshing = false;
        let reconnected = false;
        let generation = 0;
        h.pauseRefresh(async (task) => {
          refreshing = true;
          while (!reconnected) await task.sleep(1, "wait for newer login commit");
        });
        h.invalidateRefresh();
        const run = await sim.runTasks([
          {
            name: "setup",
            f: async (task) => {
              expect((await h.make().start(task, binding, "first", "browser")).isOk()).toBe(true);
              expect(
                (await h.make().complete(task, binding, "first", "browser", "code")).isOk(),
              ).toBe(true);
              generation = h.state()?.generation ?? 0;
              ready = true;
            },
          },
          {
            name: "orb-broker",
            f: async (task) => {
              while (!ready) await task.sleep(1, "wait for initial grant");
              const token = await h
                .make()
                .token(task, binding, { reason: "rejected", staleGeneration: generation });
              expect(token.isOk()).toBe(true);
              if (token.isOk()) expect(token.value.generation).toBeGreaterThan(generation);
            },
          },
          {
            name: "browser-reconnect",
            f: async (task) => {
              while (!refreshing) await task.sleep(1, "wait for old refresh acceptance");
              expect((await h.make().start(task, binding, "second", "browser")).isOk()).toBe(true);
              expect(
                (await h.make().complete(task, binding, "second", "browser", "code")).isOk(),
              ).toBe(true);
              reconnected = true;
            },
          },
        ]);
        expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
        expect(h.state()?.secretVersion).not.toBeNull();
        expect(h.edges.slice(h.edges.lastIndexOf("connected") + 1)).not.toContain("invalidated");
      },
    );
  });

  it("independent instances cannot publish a callback after a disconnect fence", async () => {
    await runDst(
      { name: "mcp-oauth-independent-fence", iterations: 80, lateTimerProbability: 0 },
      async (sim) => {
        const h = harness();
        let prepared = false;
        let accepted = false;
        let disconnected = false;
        h.pauseExchange(async (task) => {
          accepted = true;
          while (!disconnected) await task.sleep(1, "wait for disconnect fence");
        });
        const result = await sim.runTasks([
          {
            name: "browser-start",
            f: async (task) => {
              expect((await h.make().start(task, binding, "state", "browser")).isOk()).toBe(true);
              prepared = true;
            },
          },
          {
            name: "callback-instance",
            f: async (task) => {
              while (!prepared) await task.sleep(1, "wait for durable attempt");
              expect(
                (await h.make().complete(task, binding, "state", "browser", "code")).isErr(),
              ).toBe(true);
            },
          },
          {
            name: "disconnect-instance",
            f: async (task) => {
              while (!accepted) await task.sleep(1, "wait for provider code consumption");
              expect((await h.make().disconnect(task, binding)).isOk()).toBe(true);
              disconnected = true;
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(h.state()?.secretVersion).toBeNull();
        expect(h.edges).not.toContain("connected");
        expect(h.exchanges()).toBe(1);
      },
    );
  });

  it("code response loss and persistence failure never repeat an exchange, and attempts expire visibly", async () => {
    await runDst(
      { name: "mcp-oauth-loss-expiry", iterations: 35, lateTimerProbability: 0 },
      async (sim) => {
        const h = harness();
        const run = await sim.runTasks([
          {
            name: "browser",
            f: async (task) => {
              expect((await h.make().start(task, binding, "first", "browser")).isOk()).toBe(true);
              expect(
                (await h.make().complete(task, binding, "first", "wrong-browser", "code")).isErr(),
              ).toBe(true);
              expect(h.exchanges()).toBe(0);
              h.loseExchange();
              expect(
                (await h.make().complete(task, binding, "first", "browser", "code")).isErr(),
              ).toBe(true);
              expect(
                (await h.make().complete(task, binding, "first", "browser", "code")).isErr(),
              ).toBe(true);
              expect(h.exchanges()).toBe(1);
              expect((await h.make().status(task, binding))._unsafeUnwrap()).toBe("auth_required");
              expect((await h.make().start(task, binding, "second", "browser")).isOk()).toBe(true);
              await task.sleep(10 * 60_000 + 1, "browser abandoned consent");
              expect(
                (await h.make().complete(task, binding, "second", "browser", "code")).isErr(),
              ).toBe(true);
              expect((await h.make().status(task, binding))._unsafeUnwrap()).toBe("auth_required");
              expect(h.edges).toContain("expired");
              expect(h.exchanges()).toBe(1);
              const failedStorage = harness();
              expect(
                (await failedStorage.make().start(task, binding, "storage", "browser")).isOk(),
              ).toBe(true);
              failedStorage.secrets.failWrites = true;
              expect(
                (
                  await failedStorage.make().complete(task, binding, "storage", "browser", "code")
                ).isErr(),
              ).toBe(true);
              failedStorage.secrets.failWrites = false;
              expect(
                (
                  await failedStorage.make().complete(task, binding, "storage", "browser", "code")
                ).isErr(),
              ).toBe(true);
              expect(failedStorage.exchanges()).toBe(1);
              expect(failedStorage.state()?.secretVersion).toBeNull();
            },
          },
        ]);
        expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
      },
    );
  });

  it("single-use callback across instances and committed-result readback", async () => {
    await runDst({ name: "mcp-oauth-callback", iterations: 40 }, async (sim) => {
      const h = harness();
      const run = await sim.runTasks([
        {
          name: "browser",
          f: async (task) => {
            expect((await h.make().start(task, binding, "state", "browser")).isOk()).toBe(true);
            h.loseAck();
            const results = await Promise.all([
              h.make().complete(task, binding, "state", "browser", "code"),
              h.make().complete(task, binding, "state", "browser", "code"),
            ]);
            expect(results.filter((r) => r.isOk())).toHaveLength(1);
            expect(h.exchanges()).toBe(1);
            expect(h.edges.filter((e) => e === "connected")).toHaveLength(1);
            expect((await h.make().status(task, binding))._unsafeUnwrap()).toBe("connected");
          },
        },
      ]);
      expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
    });
  });
  it("fences late exchange against disconnect and project deletion", async () => {
    await runDst({ name: "mcp-oauth-delete", iterations: 50 }, async (sim) => {
      const h = harness();
      const run = await sim.runTasks([
        {
          name: "browser",
          f: async (task) => {
            expect((await h.make().start(task, binding, "state", "browser")).isOk()).toBe(true);
            const pending = h.make().complete(task, binding, "state", "browser", "code");
            await task.checkpoint("mcp:delete-arrival");
            await h.make().disconnect(task, binding);
            h.remove();
            await pending;
            expect((await h.make().token(task, binding, { reason: "startup" })).isErr()).toBe(true);
            const disconnect = h.edges.lastIndexOf("disconnected");
            if (disconnect >= 0) expect(h.edges.slice(disconnect + 1)).not.toContain("connected");
          },
        },
      ]);
      expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
    });
  });
  it("coalesces two orb refreshes, rejects another project and an old ceremony", async () => {
    await runDst({ name: "mcp-oauth-refresh", iterations: 40 }, async (sim) => {
      const h = harness();
      const run = await sim.runTasks([
        {
          name: "orbs",
          f: async (task) => {
            const a = h.make();
            const b = h.make();
            await a.start(task, binding, "old", "browser");
            expect((await b.start(task, binding, "new", "browser")).isOk()).toBe(true);
            expect((await a.complete(task, binding, "old", "browser", "code")).isErr()).toBe(true);
            expect((await b.complete(task, binding, "new", "browser", "code")).isOk()).toBe(true);
            const generation = h.state()?.generation ?? -1;
            const grants = await Promise.all([
              a.token(task, binding, { reason: "rejected", staleGeneration: generation }),
              b.token(task, binding, { reason: "rejected", staleGeneration: generation }),
            ]);
            expect(grants.every((g) => g.isOk())).toBe(true);
            expect(h.refreshes()).toBe(1);
            expect(
              (
                await a.token(task, { ...binding, projectId: "foreign" }, { reason: "startup" })
              ).isErr(),
            ).toBe(true);
          },
        },
      ]);
      expect(run.isOk(), run.isErr() ? run.error.message : "").toBe(true);
    });
  });
});
