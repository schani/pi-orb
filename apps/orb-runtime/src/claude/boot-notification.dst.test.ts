import { join } from "node:path";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { planBootNotification } from "../pi/boot-notification.ts";
import { ComposedClaudeFixture, ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { claudeBootEntries } from "./boot-notification.ts";
import { ClaudeHistory } from "./history.ts";

it("a crash or abort after the durable boot claim cancels admission before the native prompt", async () => {
  await runDst({ name: "claude-boot-claim-before-submit", iterations: 20 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    let releaseAccount: () => void = () => undefined;
    const account = new Promise<void>((resolve) => {
      releaseAccount = resolve;
    });
    const queries: ScheduledClaudeQuery[] = [];
    const agent = new ClaudeOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir: f.dir,
      skillsDir: null,
      broker: null,
      sdkFactory: (input, options) => {
        const query = new ScheduledClaudeQuery(input, options, queries.length === 0);
        if (queries.length > 0)
          query.accountInfo = async () => {
            await account;
            return { apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" };
          };
        queries.push(query);
        return ok({
          query,
          exited: query.processExit.promise,
          stdoutEnded: query.stdoutEnded,
          requestShutdown: () => query.requestShutdown(),
        });
      },
    });
    f.append({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
    let claimed = false;
    let inspected = false;
    try {
      const result = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            expect(
              (await agent.attachSession(f.state, f.history, f.configDir, "commit", null)).isOk(),
            ).toBe(true);
            claimed = true;
            await task.checkpoint("boot claim fsynced; native account initialization blocked");
            expect(agent.gateView().activity).toBe("busy");
            expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
            const entries = claudeBootEntries(
              new ClaudeHistory(join(f.dir, "claude"), f.state.id, f.state.timestamp).view,
            );
            const next = planBootNotification(entries, entries, {
              runtimeInstanceId: "after-crash",
              executionId: null,
              incarnation: "0",
            });
            expect(next).toMatchObject({
              kind: "message",
              triggerTurn: true,
              marker: { details: { reason: "resumed" } },
            });
            inspected = true;
          },
        },
        {
          name: "cancel-and-inbox",
          f: async (task) => {
            while (!claimed) await task.checkpoint("wait for durable boot claim");
            expect(
              (
                await agent.deliverInboxMessage(
                  "later",
                  ["later"],
                  [{ type: "text", text: "later" }],
                )
              ).isErr(),
            ).toBe(true);
            while (!inspected) await task.checkpoint("wait for recovery ownership inspection");
            await task.checkpoint("cancel recovery before native input admission");
            const aborted = agent.abortOperation();
            releaseAccount();
            const query = queries[1];
            expect(query).toBeDefined();
            query?.exit();
            query?.endOutput();
            await aborted;
            expect(await query?.input.next()).toMatchObject({ done: true });
            expect(f.state.deliveries).toEqual({});
            expect(
              f.history.view.filter(
                (record) => record.type === "event" && record.eventType === "pi-orb.turn-resume",
              ),
            ).toHaveLength(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    } finally {
      f.dispose();
    }
  });
});
