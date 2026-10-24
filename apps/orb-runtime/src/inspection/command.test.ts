import { CHART_CONTENT_TYPE, type OrbInspectionItem, type OrbTranscript } from "@pi-orb/protocol";
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
  it.each([
    [["search", "a phrase"], { query: "a phrase" }, false],
    [
      ["search", "x", "--orb", "other", "--json", "--limit", "50"],
      { query: "x", orbId: "other", limit: 50 },
      true,
    ],
    [["search", "--project", "x"], { query: "x", scope: "project" }, false],
    [["search", "x", "--all"], { query: "x", scope: "user" }, false],
  ])("parses %j", (args, request, json) => {
    expect(parseInspectionArgs(args)._unsafeUnwrap()).toEqual({ type: "search", request, json });
  });
  it.each([
    ["search"],
    ["search", "x", "y"],
    ["search", "x", "--orb"],
    ["search", "x", "--orb", "o", "--project"],
    ["search", "x", "--all", "--all"],
    ["search", "x", "--wat"],
    ...["1x", "1e1"].map((n) => ["search", "x", "--limit", n]),
    ["search", "x", "--limit"],
    ["search", "x", "--limit", "1", "--limit", "2"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(parseInspectionArgs(args).isErr()).toBe(true);
  });

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
  it("searches and renders projects without a repository", () => {
    const source = items[0];
    if (source === undefined) throw new Error("missing fixture");
    const orb = { ...source, project: { ...source.project, repositoryUrl: null } };
    expect(filterOrbs([orb], "github")).toEqual([]);
    expect(filterOrbs([orb], "pi-orb")).toEqual([orb]);
    expect(formatOrbList([orb], orb.id)).toContain("pi-orb\t—\n");
    expect(
      formatSelf({
        v: 1,
        orb: {
          id: orb.id,
          name: orb.name,
          url: "https://example.com/orbs/test",
          createdAt: orb.updatedAt,
        },
        project: orb.project,
        spawnedByOrb: null,
        children: [],
        previewHost: null,
      }),
    ).toContain("Repository: —");
    expect(
      formatTranscript({ v: 1, orb, session: null, cursor: null, headId: null, records: [] }),
    ).toContain("Repository: —");
  });

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
      spawnedByOrb: null,
      children: [],
      previewHost: null,
    };
    const output = formatSelf(self);
    expect(output).toContain("https://browser.test/orbs/orb-a");
    expect(output).toContain("2026-10-01T00:00:00.000Z");
    expect(output).not.toContain("Preview:");
    expect(output).not.toContain("Spawned by:");
    expect(output).not.toContain("Child:");
    const family = formatSelf({
      ...self,
      spawnedByOrb: { id: "parent", url: "https://browser.test/orbs/parent" },
      children: [
        { id: "child", name: "Parser\nwork", url: "https://browser.test/orbs/child" },
        { id: "unnamed", name: null, url: "https://browser.test/orbs/unnamed" },
      ],
    });
    expect(family).toContain("Spawned by: parent (https://browser.test/orbs/parent)");
    expect(family).toContain("Child: Parser work (child) https://browser.test/orbs/child");
    expect(family).toContain("Child: untitled orb (unnamed) https://browser.test/orbs/unnamed");
    expect(
      formatSelf({
        ...self,
        spawnedByOrb: { id: "parent", url: "https://browser.test/orbs/parent" },
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

  it("exports a typed child notification message once as literal text", () => {
    const orb = items[0];
    if (orb === undefined) return;
    const message = "Child line\n<strong>literal HTML</strong>";
    const output = formatTranscript({
      v: 1,
      orb,
      session: { id: "session", overflow: {} },
      cursor: "notice",
      headId: "notice",
      records: [
        {
          id: "notice",
          parentId: null,
          timestamp: "t",
          type: "event",
          eventType: "pi.custom_message",
          overflow: {},
          custom: { customType: "subagent-notification", display: true },
          subagent: { kind: "notification", id: "7", description: "Check", message },
        },
      ],
    });
    expect(output).toContain("## subagent notification: Check (7)\n\n" + message);
    expect(output.split(message)).toHaveLength(2);
    expect(output).not.toContain("agent_id");
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

  it("names charts instead of dumping their data", () => {
    const sibling = items[1];
    if (sibling === undefined) throw new Error("missing fixture");
    const output = formatTranscript({
      v: 1,
      orb: sibling,
      session: { id: "session-a", overflow: {} },
      cursor: "record-1",
      headId: "record-1",
      records: [
        {
          id: "record-1",
          parentId: null,
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "message",
          role: "tool",
          content: [
            {
              type: "tool_result",
              callId: "call-1",
              content: [
                { type: "text", text: "Script completed" },
                {
                  type: "other",
                  contentType: CHART_CONTENT_TYPE,
                  data: {
                    kind: "bar",
                    title: "slowest endpoints",
                    bars: [{ label: "a", value: 412 }],
                  },
                },
              ],
            },
          ],
          overflow: {},
        },
      ],
    });
    expect(output).toContain(
      "[tool result: call-1]\nScript completed\n\n[chart: slowest endpoints]",
    );
    expect(output).not.toContain("412");
  });
});

it("renders peer source and full literal body once in text and JSON transcripts", () => {
  const senderOrbId = "11111111-1111-4111-8111-111111111111";
  const body = "<script>literal</script>\nsecond line";
  const transcript: OrbTranscript = {
    v: 1,
    orb: items[0]!,
    session: null,
    cursor: "peer",
    headId: "peer",
    records: [
      {
        id: "peer",
        parentId: null,
        timestamp: "t",
        overflow: { native: "PRIVATE_PEER_OVERFLOW" },
        type: "event",
        eventType: "orb.message",
        sender: { orbId: senderOrbId },
        content: [{ type: "text", text: body }],
        inboxMessageIds: ["inbox"],
      },
    ],
  };
  const output = formatTranscript(transcript);
  expect(output).toContain(`## orb message from ${senderOrbId}\n\n${body}`);
  expect(output.split(senderOrbId)).toHaveLength(2);
  expect(output.split(body)).toHaveLength(2);
  expect(output).not.toContain("PRIVATE_PEER_OVERFLOW");
});
