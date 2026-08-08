import { describe, expect, it } from "vitest";
import { projectDeletionConfirmation, projectDeletionProgressText } from "./project-deletion.ts";

describe("project deletion presentation", () => {
  it("names every destructive ownership class in confirmation copy", () => {
    const copy = projectDeletionConfirmation("Demo");
    expect(copy).toContain("project");
    expect(copy).toContain("every orb");
    expect(copy).toContain("checkouts and files");
    expect(copy).toContain("compute resources");
    expect(copy).toContain("port access");
    expect(copy).toContain("all conversation history");
    expect(copy).toContain("permanently");
  });

  it("shows remaining and blocked child cleanup", () => {
    expect(projectDeletionProgressText({ total: 4, remaining: 2, blocked: 1 })).toBe(
      "deleting orbs: 2 of 4 remaining · 1 blocked",
    );
    expect(projectDeletionProgressText({ total: 0, remaining: 0, blocked: 0 })).toBe(
      "deleting orbs: 0 of 0 remaining",
    );
  });
});
