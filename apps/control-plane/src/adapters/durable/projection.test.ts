import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { activeSubagents, projectEntry } from "./projection.ts";

const entry = (value: object) => ({ id: 2, conversationId: 1, ...value }) as EntryRecord;
describe("Durable root projection", () => {
  it("maps public settings one-to-one without serializing private configuration", () => {
    for (const [kind, data, native] of [
      [
        "orb.model-change",
        { provider: "faux", modelId: "one" },
        { type: "model_change", provider: "faux", modelId: "one" },
      ],
      [
        "orb.thinking-level-change",
        { thinkingLevel: "high" },
        { type: "thinking_level_change", thinkingLevel: "high" },
      ],
    ] as const) {
      const record = projectEntry(
        entry({
          kind,
          data: {
            ...data,
            timestamp: 1000,
            instructions: "PRIVATE",
            config: { secret: "PRIVATE" },
          },
        }),
        "session:1",
        "session",
      )._unsafeUnwrap();
      expect(record).toEqual({
        id: "session:2",
        parentId: "session:1",
        timestamp: "1970-01-01T00:00:01.000Z",
        type: "event",
        eventType: `pi.${native.type}`,
        overflow: {
          native: {
            ...native,
            id: "session:2",
            parentId: "session:1",
            timestamp: "1970-01-01T00:00:01.000Z",
          },
        },
      });
    }
    expect(
      projectEntry(
        entry({ kind: "pi.agent", data: { instructions: "PRIVATE" } }),
        null,
        "session",
      )._unsafeUnwrap(),
    ).toBeNull();
  });
  it("includes child conversation work after its background anchor became terminal", () => {
    const graph = {
      tasks: {
        "3": {
          id: 3,
          kind: "pi.generation",
          conversationId: 2,
          background: false,
          abortRequested: false,
          state: { status: "running", phase: "request" },
          conversations: [],
        },
      },
    } as unknown as import("@earendil-works/pi-durable").TaskGraph;
    expect(
      activeSubagents(graph, 1 as import("@earendil-works/pi-durable").ConversationId),
    ).toEqual([{ id: "2", description: "Subagent 2", phase: "running" }]);
  });
  it("stamps a compaction with the time its summary was placed", () => {
    expect(
      projectEntry(
        entry({
          kind: "pi.compaction",
          head: 1,
          data: { reason: "threshold" },
          model: [
            {
              role: "user",
              content: [{ type: "text", text: "Summary." }],
              timestamp: Date.UTC(2026, 9, 24, 12),
            },
          ],
        }),
        "session:1",
        "session",
      )._unsafeUnwrap(),
    ).toEqual({
      id: "session:2",
      parentId: "session:1",
      timestamp: "2026-10-24T12:00:00.000Z",
      overflow: {},
      type: "compaction",
      summary: [{ type: "text", text: "Summary." }],
    });
  });
  it("projects image input and assistant reasoning without exposing prompts", () => {
    const user = projectEntry(
      entry({
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
            timestamp: 1000,
          },
        ],
      }),
      null,
      "session",
    )._unsafeUnwrap();
    expect(user?.type).toBe("message");
    if (user?.type === "message")
      expect(user.content[0]).toMatchObject({
        type: "image",
        data: "eA==",
        mediaType: "image/png",
      });
    expect(
      projectEntry(
        entry({
          kind: "pi.system",
          data: { secret: "hidden" },
          model: [{ role: "system", content: "hidden" }],
        }),
        null,
        "session",
      )._unsafeUnwrap(),
    ).toBeNull();
  });
});

it("projects child task headers independently of private child history", () => {
  const records = [42, 54].map(
    (id) =>
      projectEntry(
        entry({
          id,
          kind: "orb.subagent-task",
          data: {
            childId: id,
            prompt: `Task ${id}`,
            description: id === 54 ? "Existing header" : " \n ",
            timestamp: 1000,
            instructions: "PRIVATE",
          },
        }),
        null,
        "session",
      )._unsafeUnwrap()!,
  );
  expect(records[0]).toMatchObject({
    type: "event",
    eventType: "agent.subagent_task",
    subagentTask: { id: "42", prompt: "Task 42" },
    overflow: {},
  });
  const graph = {
    tasks: {
      a: { conversationId: 42, conversations: [], state: { status: "running" } },
      b: { conversationId: 54, conversations: [], state: { status: "pending" } },
    },
  } as unknown as import("@earendil-works/pi-durable").TaskGraph;
  expect(
    activeSubagents(graph, 1 as import("@earendil-works/pi-durable").ConversationId, records),
  ).toEqual([
    { id: "42", description: "Subagent 42", phase: "running", taskRecordId: "session:42" },
    { id: "54", description: "Existing header", phase: "queued" },
  ]);
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});

it.each(["ok", "error", "cancelled"])(
  "whitelists explicit codemode argument keys for %s previews",
  (status) => {
    const secret = "PRIVATE_NESTED_ARGUMENT_CANARY";
    for (const args of [
      JSON.stringify({ token: secret }),
      JSON.stringify([secret]),
      `{"token":"${secret}`,
    ]) {
      const source = entry({
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "outer",
            toolName: "codemode",
            content: [{ type: "text", text: "done" }],
            details: {
              calls: [
                {
                  id: 1,
                  name: "inner",
                  args,
                  arguments: [secret],
                  argumentKeys: ["token"],
                  status,
                  startedAt: "2026-10-24T12:00:00.000Z",
                  durationMs: 2,
                  error: secret,
                  private: { token: secret },
                },
                secret,
              ],
              omittedCalls: 0,
            },
            isError: status !== "ok",
            timestamp: 1,
          },
        ],
      });
      const projected = projectEntry(source, null, "session")._unsafeUnwrap();
      expect(JSON.stringify(projected)).not.toContain(secret);
      expect(projected?.overflow.native).toMatchObject({
        message: {
          details: {
            calls: [
              {
                id: 1,
                name: "inner",
                argumentKeys: ["token"],
                status,
                startedAt: "2026-10-24T12:00:00.000Z",
                durationMs: 2,
              },
            ],
          },
        },
      });
      expect(JSON.stringify(source)).toContain(secret);
    }
  },
);

it("never infers safe key previews from raw arguments or malformed metadata", () => {
  const secret = "PRIVATE_NESTED_ARGUMENT_CANARY";
  for (const argumentKeys of [undefined, secret, ["token", { token: secret }]]) {
    const projected = projectEntry(
      entry({
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "outer",
            toolName: "codemode",
            content: [],
            details: {
              calls: [
                {
                  id: 1,
                  name: "inner",
                  args: JSON.stringify([secret]),
                  arguments: { token: secret },
                  argumentKeys,
                  status: "error",
                },
              ],
            },
            isError: true,
            timestamp: 1,
          },
        ],
      }),
      null,
      "session",
    )._unsafeUnwrap();
    expect(projected?.overflow.native).toMatchObject({
      message: { details: { calls: [{ argumentKeys: [] }] } },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
  }
  const ordinary = projectEntry(
    entry({
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "direct",
              name: "bash",
              arguments: { command: "echo intentional source" },
            },
          ],
          timestamp: 1,
        },
      ],
    }),
    null,
    "session",
  )._unsafeUnwrap();
  expect(JSON.stringify(ordinary)).toContain("echo intentional source");
});
