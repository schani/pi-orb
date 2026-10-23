import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  OrbInspectionErrorSchema,
  OrbInspectionListSchema,
  OrbSelfSchema,
  OrbTranscriptSchema,
} from "./orb-inspection.ts";

const orb = {
  id: "orb-b",
  name: "Fix checkout",
  state: "running",
  updatedAt: "2026-08-27T00:00:00.000Z",
  project: {
    id: "project-a",
    name: "pi-orb",
    repositoryUrl: "https://github.com/schani/pi-orb",
  },
} as const;

const message = {
  id: "record-1",
  parentId: null,
  timestamp: "2026-08-27T00:00:01.000Z",
  type: "message",
  role: "user",
  content: [{ type: "text", text: "Inspect the checkout" }],
  overflow: { native: { private: "preserved" } },
} as const;

describe("orb inspection schemas", () => {
  const self = {
    v: 1,
    orb: {
      id: "orb-a",
      name: null,
      url: "https://app.test/orbs/orb-a",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    project: { id: "project-a", name: "Project", repositoryUrl: "https://github.com/o/r" },
    spawnedByOrb: null,
    children: [],
    previewHost: null,
  };

  it("accepts nullable and populated self identity", () => {
    expect(Check(OrbSelfSchema, self)).toBe(true);
    expect(
      Check(OrbSelfSchema, {
        ...self,
        orb: { ...self.orb, name: "Work" },
        spawnedByOrb: { id: "parent", url: "https://app.test/orbs/parent" },
        children: [
          { id: "child", name: "Work", url: "https://app.test/orbs/child" },
          { id: "unnamed", name: null, url: "https://app.test/orbs/unnamed" },
        ],
        previewHost: "orb.tail.ts.net",
      }),
    ).toBe(true);
  });

  it("rejects unknown self fields at every object level and malformed required fields", () => {
    for (const invalid of [
      { ...self, extra: true },
      { ...self, spawnedBy: null },
      { ...self, spawnedByOrb: undefined, spawnedBy: null },
      { ...self, orb: { ...self.orb, extra: true } },
      { ...self, project: { ...self.project, extra: true } },
      { ...self, spawnedByOrb: { id: "parent", url: "https://app.test/orbs/parent", extra: true } },
      { ...self, orb: { ...self.orb, id: 42 } },
      { ...self, project: { ...self.project, name: null } },
      { ...self, spawnedByOrb: { id: "parent", url: 42 } },
      { ...self, children: undefined },
      { ...self, children: null },
      { ...self, children: [{ id: "child", url: "https://app.test/orbs/child" }] },
      { ...self, children: [{ id: 42, name: null, url: "https://app.test/orbs/child" }] },
      { ...self, children: [{ id: "child", name: 42, url: "https://app.test/orbs/child" }] },
      { ...self, children: [{ id: "child", name: null, url: 42 }] },
      { ...self, children: [{ id: "child", name: null, url: "url", extra: true }] },
      { ...self, previewHost: 42 },
      { ...self, orb: { id: "orb-a" } },
    ])
      expect(Check(OrbSelfSchema, invalid)).toBe(false);
  });
  it("accepts an authenticated cross-orb listing", () => {
    expect(Check(OrbInspectionListSchema, { v: 1, currentOrbId: "orb-a", items: [orb] })).toBe(
      true,
    );
  });

  it("accepts a lossless replicated transcript", () => {
    expect(
      Check(OrbTranscriptSchema, {
        v: 1,
        orb,
        session: { id: "session-a", overflow: { native: { id: "session-a" } } },
        cursor: "record-1",
        headId: "record-1",
        records: [message],
      }),
    ).toBe(true);
  });

  it.each(["not_found", "invalid_request"])("keeps %s failures on one typed envelope", (code) => {
    expect(
      Check(OrbInspectionErrorSchema, {
        v: 1,
        error: { code, message: "orb inspection failed", retryable: false },
      }),
    ).toBe(true);
  });
});
