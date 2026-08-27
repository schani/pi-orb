import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  OrbInspectionErrorSchema,
  OrbInspectionListSchema,
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

  it("keeps inspection failures on one typed envelope", () => {
    expect(
      Check(OrbInspectionErrorSchema, {
        v: 1,
        error: { code: "not_found", message: "orb not found", retryable: false },
      }),
    ).toBe(true);
  });
});
