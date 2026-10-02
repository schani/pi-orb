import { describe, expect, it } from "vitest";
import { parseRoute } from "./App.tsx";

describe("parseRoute", () => {
  it("uses paths, not fragments or query parameters", () => {
    expect(parseRoute("/")).toEqual({ page: "projects", focusedProjectId: null });
    expect(parseRoute("/projects/p/mcp?source=link#section")).toEqual({
      page: "mcp",
      projectId: "p",
    });
    expect(parseRoute("/orbs/o#anchor")).toEqual({ page: "orb", orbId: "o" });
    expect(parseRoute("/#/orbs/old")).toEqual({ page: "projects", focusedProjectId: null });
    expect(parseRoute("/other")).toEqual({ page: "not_found" });
    expect(parseRoute("/orbs/a%252Fb")).toEqual({ page: "orb", orbId: "a%2Fb" });
    expect(parseRoute("/orbs/%broken")).toEqual({ page: "not_found" });
  });
  it("recognizes the dashboard and focused-project dashboard URLs", () => {
    expect(parseRoute("/")).toEqual({ page: "projects", focusedProjectId: null });
    expect(parseRoute("/projects/project-1")).toEqual({
      page: "projects",
      focusedProjectId: "project-1",
    });
  });

  it("recognizes explicit orb-creation intent URLs", () => {
    expect(parseRoute("/projects/project-1/orbs/new")).toEqual({
      page: "create_orb",
      projectId: "project-1",
    });
  });

  it("keeps canonical missing orb URLs separate from creation intent", () => {
    expect(parseRoute("/orbs/orb-1")).toEqual({ page: "orb", orbId: "orb-1" });
  });
});
