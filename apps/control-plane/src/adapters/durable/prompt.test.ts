import { describe, expect, it } from "vitest";
import { environmentPrompt } from "../../../../orb-runtime/src/environment-prompt.ts";
import { piEnvironmentPrompt } from "./environment-prompt.ts";
import { renderPrompt } from "./prompt.ts";

describe("central data-only prompt", () => {
  it("orders personal, repository and project instructions and preserves skill inventory", () => {
    const prompt = renderPrompt({
      personal: "PERSONAL",
      repository: [{ path: "/guest/AGENTS.md", content: "REPO" }],
      project: "PROJECT",
      appendSystem: "APPEND",
      skills: [],
    });
    expect(prompt.indexOf("PERSONAL")).toBeLessThan(prompt.indexOf("REPO"));
    expect(prompt.indexOf("REPO")).toBeLessThan(prompt.indexOf("PROJECT"));
    expect(prompt).toContain("APPEND");
    expect(prompt).not.toContain("<cwd>");
  });
});

it.each([
  { repository: [], skills: [] },
  { repository: [{ path: "/guest/AGENTS.md", content: "REPO" }], skills: [] },
])(
  "places shared environment immediately after the preamble with the empty Pi suffix",
  (snapshot) => {
    const prompt = renderPrompt({ ...snapshot, appendSystem: "APPEND" });
    expect(piEnvironmentPrompt).toBe("");
    expect(prompt.split(environmentPrompt)).toHaveLength(2);
    expect(
      prompt.startsWith(
        `You are a coding assistant. Use tools to inspect and change the project. Be concise. Produce Markdown. Mermaid is supported.\n\n${environmentPrompt}\n\n`,
      ),
    ).toBe(true);
    expect(prompt.indexOf(environmentPrompt)).toBeLessThan(prompt.indexOf("APPEND"));
    if (snapshot.repository.length)
      expect(prompt.indexOf(environmentPrompt)).toBeLessThan(
        prompt.indexOf("<project_instructions>"),
      );
    expect(prompt).not.toContain("## Orb CLI");
    expect(prompt).not.toContain("<cwd>");
    expect(prompt).not.toContain("Host workspace pending execution readiness");
  },
);
