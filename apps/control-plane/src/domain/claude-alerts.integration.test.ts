import { projectDisplayRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { assert, expect, it, vi } from "vitest";
import { parseAlertArgs, sendAlert } from "../../../orb-runtime/src/alert/command.ts";
import { buildRuntimeServer } from "../../../orb-runtime/src/http/server.ts";
import type { TerminalManager } from "../../../orb-runtime/src/terminal/manager.ts";
import { ComposedClaudeFixture } from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { LogCapture } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";

it("projects an accepted Claude CLI alert into durable unread state and literal display data", async () => {
  const task = new NoSimulationTask("Claude alert integration", false);
  const logs = new LogCapture();
  vi.spyOn(task, "log").mockImplementation((...parts) => logs.log(...parts));
  const f = new ComposedClaudeFixture();
  const client = new PGliteClient();
  const database = composeControlPlaneDatabase(client);
  const token = "claude-alert-test";
  const app = buildRuntimeServer(
    f.agent,
    { closeAll: () => undefined } as unknown as TerminalManager,
    token,
  );
  const projectId = "00000000-0000-4000-8000-000000000011";
  const orbId = "00000000-0000-4000-8000-000000000012";
  const message = "<img src=x onerror=alert(1)>\n**not markdown** 🔔";
  try {
    (await f.attach())._unsafeUnwrap();
    (await database.migrate())._unsafeUnwrap();
    (
      await client.query(
        "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
        [TEST_USER_ID],
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, makeProjectRow(projectId)))._unsafeUnwrap();
    (
      await database.store.insertOrb(
        task,
        makeOrbRow(orbId, projectId, "running", { harness: "claude" }),
      )
    )._unsafeUnwrap();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert(address !== null && typeof address !== "string");
    const input = parseAlertArgs([message, "--request-id", "claude-alert-request"])._unsafeUnwrap();
    const accepted = (await sendAlert(input, { token, port: address.port }))._unsafeUnwrap();
    expect(accepted.duplicate).toBe(false);
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.unreadAlertId).toBeNull();

    // Provider execution and journal I/O are fake; the CLI, writer and SQL projection are real.
    const snapshot = { ...f.agent.replicationSnapshot()._unsafeUnwrap(), orbId };
    const deps = { ...makeHarness().deps, store: database.store };
    (await commitAgentHistory(task, deps, snapshot))._unsafeUnwrap();
    const orb = (await database.store.getOrb(task, orbId))._unsafeUnwrap();
    expect(orb?.replicationCursor).toBe(accepted.id);
    expect(orb?.unreadAlertId).toBe(accepted.id);

    const stored = (
      await database.store.readHistoryRecord(task, orbId, snapshot.session.id, accepted.id)
    )._unsafeUnwrap();
    assert(stored !== null);
    expect(stored).toMatchObject({
      id: accepted.id,
      type: "event",
      eventType: "pi-orb.alert",
      alert: { message, requestId: input.requestId },
      content: [{ type: "text", text: message }],
    });
    expect(projectDisplayRecord(stored)).toMatchObject({
      alert: { message, requestId: input.requestId },
    });
    expect((await sendAlert(input, { token, port: address.port }))._unsafeUnwrap()).toEqual({
      ...accepted,
      duplicate: true,
    });
    expect((await database.store.ackOrbAlert(task, orbId, accepted.id))._unsafeUnwrap()).toBeNull();
    (await commitAgentHistory(task, deps, snapshot))._unsafeUnwrap();
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.unreadAlertId).toBeNull();
    expect(logs.matching("alert-published")).toHaveLength(1);
    expect(logs.matching("alert-published")[0]).toContain(accepted.id);
  } finally {
    await app.close();
    (await database.close())._unsafeUnwrap();
    f.dispose();
  }
});
