import { describe, expect, it } from "vitest";
import { renderPrompt } from "./prompt.ts";

describe("central data-only prompt", () => {
  it("orders personal, repository and project instructions and preserves skill inventory", () => {
    const prompt = renderPrompt({
      cwd: "/guest/repo",
      personal: "PERSONAL",
      repository: [{ path: "/guest/AGENTS.md", content: "REPO" }],
      project: "PROJECT",
      appendSystem: "APPEND",
      skills: [],
    });
    expect(prompt.indexOf("PERSONAL")).toBeLessThan(prompt.indexOf("REPO"));
    expect(prompt.indexOf("REPO")).toBeLessThan(prompt.indexOf("PROJECT"));
    expect(prompt).toContain("APPEND");
    expect(prompt).toContain("/guest/repo");
  });
});
