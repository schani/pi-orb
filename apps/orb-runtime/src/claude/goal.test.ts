import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RUNTIME_SUBPROTOCOL, type ServerFrame } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { expect, it, onTestFinished } from "vitest";
import type { WebSocket } from "ws";
import { buildRuntimeServer } from "../http/server.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import {
  ComposedClaudeFixture,
  rootResult,
  ScheduledClaudeQuery,
} from "../testkit/claude-composed.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { ClaudeHistory } from "./history.ts";

const objective = "Get the tests passing.";
const builtin = { name: "goal", builtin: true, description: "", argumentHint: "" };

function fixture(
  commands: (typeof builtin)[] | Promise<(typeof builtin)[]> = [builtin],
  operationAccountReady?: Promise<void>,
  files = new ComposedClaudeFixture(),
) {
  const queries: ScheduledClaudeQuery[] = [];
  let ready: (query: ScheduledClaudeQuery) => void = () => undefined;
  const agent = new ClaudeOrbAgent({
    orbId: "orb-a",
    repositoryUrl: null,
    workDir: files.dir,
    skillsDir: null,
    broker: null,
    files: files.files,
    yieldMessage: async () => undefined,
    sdkFactory: (input, options) => {
      const query = Object.assign(new ScheduledClaudeQuery(input, options, queries.length === 0), {
        supportedCommands: async () => commands,
      });
      if (queries.length > 0 && operationAccountReady !== undefined)
        query.accountReady = operationAccountReady;
      queries.push(query);
      ready(query);
      return ok({
        query,
        exited: query.processExit.promise,
        stdoutEnded: query.stdoutEnded,
        requestShutdown: () => query.requestShutdown(),
      });
    },
  });
  agent.subscribe((frame) => files.frames.push(frame));
  return {
    ...files,
    agent,
    attach: () => agent.attachSession(files.state, files.history, files.configDir, null),
    nextQuery: () =>
      new Promise<ScheduledClaudeQuery>((resolve) => {
        ready = resolve;
      }),
    append: (entry: object) => files.append(entry),
    dispose: () => {
      for (const query of queries) {
        query.exit();
        query.endOutput();
      }
      files.dispose();
    },
  };
}

function goalRecord(sessionId: string, met = false, condition = objective) {
  return {
    type: "attachment",
    uuid: randomUUID(),
    sessionId,
    isSidechain: false,
    attachment: { type: "goal_status", met, sentinel: true, condition },
  };
}

function receipt(f: ReturnType<typeof fixture>, uuid: string, sentinel: string, args: string) {
  f.append({
    type: "user",
    uuid,
    parentUuid: sentinel,
    sessionId: f.state.id,
    isSidechain: false,
    rowSource: "local",
    turnAttributionKey: uuid,
    message: {
      role: "user",
      content: `<command-name>/goal</command-name>
<command-message>goal</command-message>
<command-args>${args}</command-args>`,
    },
  });
  f.append({
    type: "system",
    subtype: "local_command",
    uuid: randomUUID(),
    parentUuid: uuid,
    sessionId: f.state.id,
    isSidechain: false,
    commandRun: { command: "goal", args },
  });
}

it("closes a hello during Claude startup and advertises goal and writable settings on reconnect without a turn", async () => {
  let provideCommands: (commands: (typeof builtin)[]) => void = () => undefined;
  const f = fixture(
    new Promise((resolve) => {
      provideCommands = resolve;
    }),
  );
  const app = buildRuntimeServer(f.agent, { closeAll: () => undefined } as TerminalManager);
  const sockets: WebSocket[] = [];
  const metadataQuery = f.nextQuery();
  const attach = f.attach();
  onTestFinished(async () => {
    provideCommands([builtin]);
    await attach;
    for (const socket of sockets) socket.terminate();
    await app.close();
    f.dispose();
  });
  await app.ready();
  const connect = async () => {
    const socket = await app.injectWS("/v1/live", {
      headers: { "sec-websocket-protocol": RUNTIME_SUBPROTOCOL },
    });
    sockets.push(socket);
    return socket;
  };
  const hello = JSON.stringify({
    v: 1,
    type: "client.hello",
    clientInstanceId: "test",
    afterRecordId: null,
  });
  const early = await connect();
  const closed = once(early, "close");
  early.send(hello);
  expect((await closed)[0]).toBe(1013);

  provideCommands([builtin]);
  expect((await attach).isOk()).toBe(true);
  expect(await (await metadataQuery).input.next()).toEqual({ done: true, value: undefined });
  const ready = await connect();
  const messages = on(ready, "message", { close: ["close"] });
  const frames: ServerFrame[] = [];
  ready.send(hello);
  for await (const [data] of messages) {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    frames.push(frame);
    if (frame.type === "sync.completed") break;
  }
  expect(frames[0]).toMatchObject({
    type: "server.welcome",
    capabilities: expect.arrayContaining(["goal"]),
  });
  expect(frames).toContainEqual(
    expect.objectContaining({
      type: "runtime.event",
      event: expect.objectContaining({ type: "agent_settings", writable: true }),
    }),
  );
  expect(frames).toContainEqual(
    expect.objectContaining({
      type: "runtime.event",
      event: { type: "goal_state", goal: null },
    }),
  );
  expect(frames.at(-1)).toMatchObject({ type: "sync.completed" });
});

it("does not advertise a user-defined goal command", async () => {
  const f = fixture([{ ...builtin, builtin: false }]);
  try {
    await f.attach();
    expect(f.agent.snapshot()._unsafeUnwrap()).not.toHaveProperty("goal");
    expect(f.agent.canChangeGoal({ type: "goal_set", objective })._unsafeUnwrapErr().code).toBe(
      "unsupported",
    );
  } finally {
    f.dispose();
  }
});

it("keeps native Clear aliases out of Set and enforces native limits", async () => {
  const f = fixture();
  try {
    await f.attach();
    expect(f.agent.snapshot()._unsafeUnwrap().goal).toBeNull();
    for (const invalid of [
      " CLEAR ",
      "stop",
      "OFF",
      "reset",
      "none",
      "Cancel",
      " ",
      "x".repeat(4001),
      "🙂".repeat(2001),
      "work\0rest",
      "work\ud800",
    ])
      expect(
        f.agent.canChangeGoal({ type: "goal_set", objective: invalid })._unsafeUnwrapErr().code,
      ).toBe("invalid_request");
    expect(
      f.agent.canChangeGoal({ type: "goal_set", objective: "Clear failing tests" }).isOk(),
    ).toBe(true);
  } finally {
    f.dispose();
  }
});

it("restores a same-session native goal; foreign attachments and invalid envelopes cannot change it", async () => {
  const f = fixture();
  try {
    const retained = goalRecord(f.state.id);
    f.append(retained);
    f.append(goalRecord(randomUUID(), true));
    f.append({ ...goalRecord(f.state.id, true), attachment: { type: "goal_status", met: "true" } });
    await f.attach();
    expect(f.agent.snapshot()._unsafeUnwrap().goal).toEqual({
      revision: retained.uuid,
      objective,
      status: "active",
    });
    expect(f.agent.canChangeGoal({ type: "goal_set", objective })._unsafeUnwrapErr().code).toBe(
      "invalid_request",
    );
  } finally {
    f.dispose();
  }
});

it("acknowledges proven native Set while retaining turn ownership through the native result", async () => {
  const f = fixture();
  try {
    await f.attach();
    expect(f.agent.snapshot()._unsafeUnwrap().goal).toBeNull();
    const next = f.nextQuery();
    const operation = f.agent.changeGoal({ type: "goal_set", objective: ` ${objective} ` });
    expect(f.agent.gateView().activity).toBe("busy");
    const query = await next;
    const command = (await query.input.next()).value;
    const uuid = command.uuid;
    if (uuid === undefined) throw new Error("Native command UUID missing.");
    expect(command).toMatchObject({ message: { role: "user", content: `/goal ${objective}` } });
    expect(command).not.toHaveProperty("client_composed");
    expect(f.agent.canCompact().isErr()).toBe(true);
    expect(
      (
        await f.agent.deliverInboxMessage(
          "waiting",
          ["waiting"],
          [{ type: "text", text: "queued" }],
        )
      ).isErr(),
    ).toBe(true);

    const retained = goalRecord(f.state.id);
    f.append(retained);
    receipt(f, uuid, retained.uuid, objective);
    await query.emitUnscheduled({
      type: "assistant",
      session_id: f.state.id,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      message: { model: "<synthetic>" },
      local_command_source: "<local-command-stdout>Goal set</local-command-stdout>",
      local_command_run: { command: "goal", args: objective },
    } as unknown as SDKMessage);
    expect((await operation).isOk()).toBe(true);
    expect(query.closeRequested).toBe(false);
    expect(f.agent.gateView().activity).toBe("busy");
    expect(
      f.agent.canChangeGoal({ type: "goal_clear", revision: retained.uuid })._unsafeUnwrapErr(),
    ).toEqual({ code: "busy", message: "Abort the current turn before clearing." });
    await query.emitUnscheduled({
      ...rootResult,
      session_id: f.state.id,
      user_message_uuid: randomUUID(),
    } as SDKMessage);
    expect(query.closeRequested).toBe(false);
    await query.emitUnscheduled({
      ...rootResult,
      session_id: f.state.id,
      user_message_uuid: uuid,
    } as SDKMessage);
    query.exit();
    expect(f.agent.gateView().activity).toBe("busy");
    query.endOutput();
    await f.agent.closeExtensions();
    const snapshot = f.agent.snapshot()._unsafeUnwrap();
    expect(snapshot.goal).toEqual({ revision: retained.uuid, objective, status: "active" });
    expect(
      snapshot.records.filter((record) => record.type === "message" && record.role === "user"),
    ).toEqual([]);
    expect(
      f.frames.some((frame) => frame.type === "runtime.event" && frame.event.type === "goal_state"),
    ).toBe(true);
  } finally {
    f.dispose();
  }
});

it("admits Clear only for the current revision and confirms it with native history", async () => {
  const f = fixture();
  try {
    const retained = goalRecord(f.state.id);
    f.append(retained);
    await f.attach();
    expect(
      f.agent.canChangeGoal({ type: "goal_clear", revision: "stale" })._unsafeUnwrapErr().code,
    ).toBe("invalid_request");
    const next = f.nextQuery();
    const operation = f.agent.changeGoal({ type: "goal_clear", revision: retained.uuid });
    const query = await next;
    const command = (await query.input.next()).value;
    const uuid = command.uuid;
    if (uuid === undefined) throw new Error("Native command UUID missing.");
    expect(command).toMatchObject({ message: { role: "user", content: "/goal clear" } });
    const cleared = goalRecord(f.state.id, true);
    f.append(cleared);
    const caveat = randomUUID();
    f.append({
      type: "user",
      uuid: caveat,
      parentUuid: cleared.uuid,
      sessionId: f.state.id,
      isSidechain: false,
      isMeta: true,
      rowSource: "harness",
      message: {
        role: "user",
        content: "<local-command-caveat>Native caveat</local-command-caveat>",
      },
    });
    receipt(f, uuid, caveat, "clear");
    await query.emitUnscheduled({
      ...rootResult,
      session_id: f.state.id,
      num_turns: 0,
      local_command: "goal",
      user_message_uuid: uuid,
    } as SDKMessage);
    query.exit();
    query.endOutput();
    expect((await operation).isOk()).toBe(true);
    expect(f.agent.snapshot()._unsafeUnwrap().goal).toBeNull();
  } finally {
    f.dispose();
  }
});

it("does not acknowledge an owned result whose sentinel belongs to something else", async () => {
  const f = fixture();
  try {
    await f.attach();
    expect(f.agent.snapshot()._unsafeUnwrap().goal).toBeNull();
    const next = f.nextQuery();
    const operation = f.agent.changeGoal({ type: "goal_set", objective });
    const query = await next;
    const command = (await query.input.next()).value;
    const uuid = command.uuid;
    if (uuid === undefined) throw new Error("Native command UUID missing.");
    f.append(goalRecord(f.state.id));
    receipt(f, uuid, randomUUID(), objective);
    await query.emitUnscheduled({
      ...rootResult,
      session_id: f.state.id,
      user_message_uuid: uuid,
    } as SDKMessage);
    query.exit();
    query.endOutput();
    expect((await operation)._unsafeUnwrapErr().message).toBe(
      "Claude did not apply the goal command.",
    );
  } finally {
    f.dispose();
  }
});

it.each([false, true])("publishes native terminal goal outcome (failed=%s)", async (failed) => {
  const f = fixture();
  try {
    f.append(goalRecord(f.state.id));
    await f.attach();
    const outcome = goalRecord(f.state.id);
    f.append({
      ...outcome,
      attachment: {
        type: "goal_status",
        condition: objective,
        met: !failed,
        ...(failed ? { failed } : {}),
      },
    });
    const snapshot = f.agent.snapshot()._unsafeUnwrap();
    expect(snapshot.goal).toBeNull();
    expect(snapshot.records.find((r) => r.id === outcome.uuid)).toMatchObject({
      eventType: "claude.goal_outcome",
      content: [
        { type: "text", text: failed ? "Goal could not be completed." : "Goal completed." },
      ],
      custom: { display: true },
    });
  } finally {
    f.dispose();
  }
});

it("does not hide unrelated slash echoes or human lookalikes", async () => {
  const f = fixture();
  try {
    for (const [command, rowSource] of [
      ["unrelated", "local"],
      ["goal", "human"],
    ]) {
      const uuid = randomUUID();
      f.append({
        type: "user",
        uuid,
        sessionId: f.state.id,
        isSidechain: false,
        rowSource,
        turnAttributionKey: uuid,
        message: { role: "user", content: `<command-name>/${command}</command-name>` },
      });
    }
    await f.attach();
    expect(
      f.agent
        .snapshot()
        ._unsafeUnwrap()
        .records.filter((r) => r.type === "message"),
    ).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it("does not resume an aborted goal turn with a dangling tool call after restart", async () => {
  const files = new ComposedClaudeFixture();
  const f = fixture([builtin], undefined, files);
  const restarted = fixture([builtin], undefined, files);
  try {
    (await f.agent.attachSession(f.state, f.history, f.configDir, null, null))._unsafeUnwrap();
    const next = f.nextQuery();
    const setting = f.agent.changeGoal({ type: "goal_set", objective });
    const query = await next;
    const command = await query.input.next();
    if (command.done || !command.value.uuid) throw new Error("Native command UUID missing.");
    const uuid = command.value.uuid;
    const retained = goalRecord(f.state.id);
    f.append(retained);
    receipt(f, uuid, retained.uuid, objective);
    await query.emitUnscheduled({
      type: "assistant",
      session_id: f.state.id,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      message: { model: "<synthetic>" },
      local_command_source: "<local-command-stdout>Goal set</local-command-stdout>",
      local_command_run: { command: "goal", args: objective },
    } as unknown as SDKMessage);
    expect((await setting).isOk()).toBe(true);

    const toolCallMessage = randomUUID();
    f.append({
      type: "assistant",
      uuid: toolCallMessage,
      parentUuid: uuid,
      sessionId: f.state.id,
      isSidechain: false,
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "call", name: "Bash", input: {} }],
      },
    });
    const aborted = f.agent.abortOperation();
    query.exit();
    query.endOutput();
    (await aborted)._unsafeUnwrap();

    const reloaded = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    (
      await restarted.agent.attachSession(f.state, reloaded, f.configDir, null, null)
    )._unsafeUnwrap();
    expect(restarted.agent.getHealth()).toMatchObject({
      status: "ready",
      activity: "idle",
      turnResume: { outcome: "notified_restart" },
    });
    const snapshot = restarted.agent.snapshot()._unsafeUnwrap();
    expect(snapshot.goal).toMatchObject({ revision: retained.uuid, status: "active" });
    expect(snapshot.records.find((record) => record.id === toolCallMessage)).toMatchObject({
      type: "message",
      role: "assistant",
      finishReason: "tool_use",
      content: [{ type: "tool_call", callId: "call" }],
    });
    expect(snapshot.records).toContainEqual(
      expect.objectContaining({
        eventType: "claude.operation_finished",
        overflow: expect.objectContaining({
          action: "goal_set",
          commandUuid: uuid,
          outcome: "aborted",
          revision: retained.uuid,
        }),
      }),
    );
  } finally {
    restarted.dispose();
    f.dispose();
  }
});

it("Abort during native initialization cannot enqueue Set later", async () => {
  let release = () => {};
  const startup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture([builtin], startup);
  try {
    await f.attach();
    const next = f.nextQuery();
    const setting = f.agent.changeGoal({ type: "goal_set", objective });
    const query = await next;
    const aborting = f.agent.abortOperation();
    expect(query.options.abortController?.signal.aborted).toBe(true);
    release();
    expect(await query.input.next()).toEqual({ done: true, value: undefined });
    expect(query.closeRequested).toBe(true);
    query.exit();
    expect(f.agent.gateView().activity).toBe("busy");
    query.endOutput();
    expect((await aborting).isOk()).toBe(true);
    expect((await setting)._unsafeUnwrapErr().message).toBe("Goal command cancelled.");
    const snapshot = f.agent.snapshot()._unsafeUnwrap();
    expect(snapshot.activity).toBe("idle");
    expect(snapshot.goal).toBeNull();
    expect(
      snapshot.records.find(
        (r) => r.type === "event" && r.eventType === "claude.operation_finished",
      ),
    ).toMatchObject({
      overflow: { action: "goal_set", outcome: "aborted" },
    });
  } finally {
    release();
    f.dispose();
  }
});
