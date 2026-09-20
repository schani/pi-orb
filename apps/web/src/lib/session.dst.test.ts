import { expect, it, vi } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { getSystem, logout, probeSession } from "./api.ts";
import {
  beginSessionRequest,
  readBrowserSession,
  readSessionGeneration,
  readSessionPrincipal,
  reportSessionPrincipal,
  resetBrowserSessionForTest,
} from "./session.ts";

it.each(["principal", "private"] as const)(
  "DST: logout fences in-flight %s response publication",
  async (kind) => {
    await runDst({ name: `browser-session-logout-${kind}`, iterations: 40 }, async (sim) => {
      resetBrowserSessionForTest();
      reportSessionPrincipal(beginSessionRequest(), "user:alice");
      let started!: () => void;
      const requestsStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const result = await sim.runTasks([
        {
          name: "alice-response",
          f: async (task) => {
            const generation = readSessionGeneration();
            vi.stubGlobal("fetch", async (path: string) => {
              if (path === "/auth/logout") return new Response(null, { status: 204 });
              await task.checkpoint("response headers");
              return {
                status: 200,
                ok: true,
                json: async () => {
                  await task.checkpoint("response body");
                  return path === "/api/v1/session"
                    ? {
                        status: "ok",
                        principal: { kind: "user", user: { id: "alice", email: null } },
                      }
                    : { hostProvider: "process", databaseKind: "pglite", version: "alice" };
                },
              };
            });
            const pending = kind === "principal" ? probeSession() : getSystem();
            started();
            const response = await pending;
            if (generation !== readSessionGeneration()) expect(response.isErr()).toBe(true);
            else expect(response.isOk()).toBe(true);
          },
        },
        {
          name: "logout",
          f: async (task) => {
            await requestsStarted;
            await task.checkpoint("logout accepted");
            expect((await logout()).isOk()).toBe(true);
          },
        },
      ]);
      vi.unstubAllGlobals();
      if (result.isErr()) throw result.error;
      expect(readBrowserSession().status).toBe("auth_required");
      expect(readSessionPrincipal()).toBeNull();
    });
  },
);
