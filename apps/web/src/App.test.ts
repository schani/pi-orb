import { describe, expect, it } from "vitest";
import { parseRoute } from "./App.tsx";

describe("parseRoute", () => {
  it("recognizes the dashboard and focused-project dashboard URLs", () => {
    expect(parseRoute("#/")).toEqual({ page: "projects", focusedProjectId: null });
    expect(parseRoute("#/projects/project-1")).toEqual({
      page: "projects",
      focusedProjectId: "project-1",
    });
  });

  it("recognizes explicit orb-creation intent URLs", () => {
    expect(parseRoute("#/projects/project-1/orbs/new")).toEqual({
      page: "create_orb",
      projectId: "project-1",
    });
  });

  it("keeps canonical missing orb URLs separate from creation intent", () => {
    expect(parseRoute("#/orbs/orb-1")).toEqual({ page: "orb", orbId: "orb-1" });
  });
});
