import { err, errAsync, ok } from "neverthrow";
import { expect, it } from "vitest";
import { FakeSecretStore } from "../testkit/broker.ts";
import { runDst } from "../testkit/sim.ts";
import { MCP_OAUTH_SECRETS, oauthError } from "./mcp-oauth.ts";
import { collectMcpOAuthGarbage, type McpOAuthGarbageStore } from "./mcp-oauth-garbage.ts";

it("retains cleanup ownership across failures/lost acknowledgement and never deletes a live version", async () => {
  await runDst({ name: "mcp-oauth-garbage", iterations: 40 }, async (sim) => {
    const secrets = new FakeSecretStore();
    const payload = { access: "secret", refresh: "refresh", accountId: "connection", expiresAt: 0 };
    const old = secrets.seedSecret(MCP_OAUTH_SECRETS, payload);
    const live = secrets.seedSecret(MCP_OAUTH_SECRETS, payload);
    const queue = new Set([old]);
    let failAck = true;
    const store: McpOAuthGarbageStore = {
      pending: async (task) => {
        await task.checkpoint("garbage:read");
        return ok([...queue]);
      },
      finish: async (task, version, destroyed) => {
        await task.checkpoint("garbage:finish");
        if (failAck) return err(oauthError("unavailable"));
        if (destroyed) queue.delete(version);
        return ok(undefined);
      },
    };
    const result = await sim.runTasks([
      {
        name: "collectors",
        f: async (task) => {
          const refused = {
            writeSecret: secrets.writeSecret.bind(secrets),
            readSecret: secrets.readSecret.bind(secrets),
            listSecretVersions: secrets.listSecretVersions.bind(secrets),
            destroySecret: () =>
              errAsync({
                type: "store_error" as const,
                code: "unavailable" as const,
                message: "secret store unavailable",
                retryable: true,
              }),
          };
          await collectMcpOAuthGarbage(task, store, refused);
          expect(queue.has(old)).toBe(true);
          await collectMcpOAuthGarbage(task, store, secrets); // destruction landed, acknowledgement lost
          expect(queue.has(old)).toBe(true);
          failAck = false;
          await Promise.all([
            collectMcpOAuthGarbage(task, store, secrets),
            collectMcpOAuthGarbage(task, store, secrets),
          ]);
          expect(queue.size).toBe(0);
          expect(secrets.liveVersions(MCP_OAUTH_SECRETS)).toEqual([live]);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
