import { DisplayHistoryViewSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { openDisplayHistory } from "../testkit/display-history.ts";

it("serves compact browser history while retaining full persisted records", async () => {
  const hidden = `HIDDEN_BROWSER_HISTORY_CANARY_${"x".repeat(100_000)}`;
  const records = Array.from({ length: 30 }, (_, i) => ({
    id: `record-${i}`,
    parentId: i ? `record-${i - 1}` : null,
    timestamp: "2026-10-02T00:00:00.000Z",
    type: "message" as const,
    role: "assistant" as const,
    content: [
      {
        type: "tool_call" as const,
        callId: `call-${i}`,
        name: "bash",
        arguments: { command: `echo ${"x".repeat(1100)}${hidden}` },
      },
      {
        type: "tool_result" as const,
        callId: `call-${i}`,
        content: [{ type: "text" as const, text: hidden }],
      },
    ],
    overflow: { native: hidden },
  }));
  const { app, harness, task } = await openDisplayHistory(records);
  {
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Check(DisplayHistoryViewSchema, body)).toBe(true);
    expect(body.records.map((record: { id: string }) => record.id)).toEqual(
      records.map((record) => record.id),
    );
    expect(body.cursor).toBe("record-29");
    expect(
      body.records
        .flatMap((record: { content: { type: string }[] }) => record.content)
        .filter((block: { type: string }) => block.type === "tool_call"),
    ).toHaveLength(30);
    expect(response.body).not.toContain("HIDDEN_BROWSER_HISTORY_CANARY_");
    expect(response.body).not.toContain("native");
    for (const block of body.records.flatMap(
      (record: { content: { headline?: string }[] }) => record.content,
    )) {
      if (block.headline)
        expect(Buffer.byteLength(block.headline, "utf8")).toBeLessThanOrEqual(1024);
    }
    const persisted = await harness.store.readHistorySnapshot(task, "orb");
    expect(persisted.isOk() && persisted.value.records[0]?.overflow?.native).toBe(hidden);
  }
});
