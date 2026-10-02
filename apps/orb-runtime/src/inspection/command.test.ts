import type { OrbInspectionItem, OrbTranscript } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  filterOrbs,
  formatOrbList,
  formatSelf,
  formatTranscript,
  INSPECTION_USAGE,
  parseInspectionArgs,
} from "./command.ts";

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
  it("lists alert in generic CLI usage", () => {
    expect(INSPECTION_USAGE).toContain('pi-orb alert "message"');
  });

  it("accepts self with optional JSON, not url or operands", () => {
    expect(parseInspectionArgs(["self"])).toMatchObject({ value: { type: "self", json: false } });
    expect(parseInspectionArgs(["--json", "self"])).toMatchObject({
      value: { type: "self", json: true },
    });
    for (const args of [["url"], ["self", "extra"], ["self", "--json", "--json"]])
      expect(parseInspectionArgs(args).isErr()).toBe(true);
  });

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
      if (parsed.isErr()) expect(parsed.error).toContain("usage:\n  pi-orb self");
    }
  });
});

describe("orb inspection presentation", () => {
  it("prints self identity and only available optional fields", () => {
    const self = {
      v: 1 as const,
      orb: {
        id: "orb-a",
        name: null,
        url: "https://browser.test/orbs/orb-a",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      project: { id: "project-a", name: "App", repositoryUrl: "https://github.com/o/r" },
      spawnedBy: null,
      previewHost: null,
    };
    const output = formatSelf(self);
    expect(output).toContain("https://browser.test/orbs/orb-a");
    expect(output).toContain("2026-10-01T00:00:00.000Z");
    expect(output).not.toContain("Preview:");
    expect(output).not.toContain("Spawned by:");
    expect(
      formatSelf({
        ...self,
        spawnedBy: { id: "parent", url: "https://browser.test/orbs/parent" },
        previewHost: "orb.tail.ts.net",
      }),
    ).toContain("orb.tail.ts.net");
  });
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

  it("renders alert text literally once without native overflow", () => {
    const orb = items[0];
    expect(orb).toBeDefined();
    if (orb === undefined) return;
    const message = "First line\n<strong>literal HTML</strong>";
    const transcript: OrbTranscript = {
      v: 1,
      orb,
      session: { id: "session-alert", overflow: { native: { duplicate: message } } },
      cursor: "record-alert",
      headId: "record-alert",
      records: [
        {
          id: "record-alert",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          type: "event",
          eventType: "pi.custom",
          alert: { message, requestId: "request-alert" },
          overflow: { native: { duplicate: message } },
        },
      ],
    };

    expect(formatTranscript(transcript)).toBe(
      "# Runtime auth (orb-current)\n\n" +
        "Project: pi-orb (project-platform)\n" +
        "Repository: https://github.com/schani/pi-orb\n" +
        "State: running\n\n" +
        "## alert\n\nFirst line\n<strong>literal HTML</strong>\n",
    );
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
