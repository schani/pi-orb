import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { instructionsAdoption as personalInstructionsAdoption } from "./instructions-adoption.ts";

describe("instruction adoption edges (shared by personal and project scopes)", () => {
  it("is silent for the initial empty default and unchanged restarts", () => {
    expect(personalInstructionsAdoption({ content: "", revision: 0 }, null)).toBeNull();
    const snapshot = { content: "private instructions", revision: 1 };
    const edge = personalInstructionsAdoption(snapshot, null);
    expect(edge).toEqual({
      revision: 1,
      sha256: createHash("sha256").update(snapshot.content).digest("hex"),
    });
    expect(JSON.stringify(edge)).not.toContain(snapshot.content);
    expect(personalInstructionsAdoption(snapshot, edge)).toBeNull();
    expect(personalInstructionsAdoption({ content: "", revision: 2 }, edge)).toMatchObject({
      revision: 2,
    });
    expect(personalInstructionsAdoption(snapshot, { revision: 1, sha256: "wrong" })).not.toBeNull();
  });
});
