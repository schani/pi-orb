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
