import type { OrbInspectionItem, OrbTranscript } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { filterOrbs, formatOrbList, formatTranscript, parseInspectionArgs } from "./command.ts";

const items: OrbInspectionItem[] = [
  {
    id: "orb-current",
    name: "Runtime auth",
    state: "running",
    updatedAt: "2026-08-27T00:00:00.000Z",
    project: {
      id: "project-platform",
      name: "pi-orb",
      repositoryUrl: "https://github.com/schani/pi-orb",
    },
  },
  {
    id: "orb-sibling",
    name: "Résumé parser",
    state: "archived",
    updatedAt: "2026-08-26T00:00:00.000Z",
    project: {
      id: "project-client",
      name: "Client App",
      repositoryUrl: "https://github.com/example/client.git",
    },
  },
];

describe("orb inspection CLI arguments", () => {
  it("parses list/search and transcript commands without a CLI framework", () => {
    expect(parseInspectionArgs(["orbs"])).toEqual({
      value: { type: "orbs", query: null, json: false },
    });
    expect(parseInspectionArgs(["orbs", "résumé", "--json"])).toEqual({
      value: { type: "orbs", query: "résumé", json: true },
    });
    expect(parseInspectionArgs(["transcript", "orb-sibling", "--json"])).toEqual({
      value: { type: "transcript", orbId: "orb-sibling", json: true },
    });
  });

  it("rejects ambiguous or incomplete commands", () => {
    for (const args of [
      ["orbs", "one", "two"],
      ["transcript"],
      ["transcript", "orb-a", "extra"],
      ["unknown"],
    ]) {
      const parsed = parseInspectionArgs(args);
      expect(parsed.isErr(), args.join(" ")).toBe(true);
      if (parsed.isErr()) expect(parsed.error).toContain("usage:\n  pi-orb orbs");
    }
  });
});

describe("orb inspection presentation", () => {
  it("searches normalized explicit identity fields but not lifecycle state", () => {
    expect(filterOrbs(items, "RÉSUMÉ").map((item) => item.id)).toEqual(["orb-sibling"]);
    expect(filterOrbs(items, "project-platform").map((item) => item.id)).toEqual(["orb-current"]);
    expect(filterOrbs(items, "github.com/example/client").map((item) => item.id)).toEqual([
      "orb-sibling",
    ]);
    expect(filterOrbs(items, "archived")).toEqual([]);
  });

  it("marks the current orb in compact tabular output", () => {
    const output = formatOrbList(items, "orb-current");
    expect(output).toContain("CURRENT\tORB ID\tNAME\tSTATE\tPROJECT");
    expect(output).toContain("*\torb-current\tRuntime auth\trunning\tpi-orb");
    expect(output).toContain("\torb-sibling\tRésumé parser\tarchived\tClient App");
  });

  it("renders normalized transcript content without native overflow", () => {
    const sibling = items[1];
    expect(sibling).toBeDefined();
    if (sibling === undefined) return;
    const transcript: OrbTranscript = {
      v: 1,
      orb: sibling,
      session: { id: "session-a", overflow: { native: { secretDuplicate: "do not render" } } },
      cursor: "record-3",
      headId: "record-3",
      records: [
        {
          id: "record-1",
          parentId: null,
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "Fix parsing" }],
          overflow: { native: { secretDuplicate: "do not render" } },
        },
        {
          id: "record-2",
          parentId: "record-1",
          timestamp: "2026-08-26T00:00:02.000Z",
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Check normalization" },
            { type: "tool_call", callId: "call-1", name: "read", arguments: { path: "a.ts" } },
            {
              type: "tool_result",
              callId: "call-1",
              content: [{ type: "text", text: "source" }],
            },
            { type: "text", text: "Implemented it." },
          ],
          overflow: {},
        },
        {
          id: "record-3",
          parentId: "record-2",
          timestamp: "2026-08-26T00:00:03.000Z",
          type: "compaction",
          summary: [{ type: "text", text: "Earlier parser work." }],
          overflow: {},
        },
      ],
    };

    const output = formatTranscript(transcript);
    expect(output).toContain("# Résumé parser (orb-sibling)");
    expect(output).toContain("## user\n\nFix parsing");
    expect(output).toContain("[reasoning]\nCheck normalization");
    expect(output).toContain('[tool call: read]\n{"path":"a.ts"}');
    expect(output).toContain("[tool result: call-1]\nsource");
    expect(output).toContain("## compaction\n\nEarlier parser work.");
    expect(output).not.toContain("secretDuplicate");
  });
});
