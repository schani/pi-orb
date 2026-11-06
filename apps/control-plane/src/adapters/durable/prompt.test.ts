import { describe, expect, it } from "vitest";
import { environmentPrompt } from "../../../../orb-runtime/src/environment-prompt.ts";
import { piEnvironmentPrompt } from "./environment-prompt.ts";
import { promptExtension, renderPrompt } from "./prompt.ts";

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
    expect(prompt.split(environmentPrompt())).toHaveLength(2);
    expect(
      prompt.startsWith(
        `You are a coding assistant. Use tools to inspect and change the project. Be concise. Produce Markdown. Mermaid is supported.\n\n${environmentPrompt()}\n\n`,
      ),
    ).toBe(true);
    expect(prompt.indexOf(environmentPrompt())).toBeLessThan(prompt.indexOf("APPEND"));
    if (snapshot.repository.length)
      expect(prompt.indexOf(environmentPrompt())).toBeLessThan(
        prompt.indexOf("<project_instructions>"),
      );
    expect(prompt).not.toContain("## Orb CLI");
    expect(prompt).not.toContain("<cwd>");
    expect(prompt).not.toContain("Host workspace pending execution readiness");
  },
);

it("keeps exact compact file guidance in root and child sections without URL metadata", async () => {
  const extension = promptExtension(renderPrompt({ repository: [], skills: [] }));
  const section = extension.sections?.[0];
  const rule =
    "When referring to an orb-local file in prose, use a Markdown link with `orb:<repository-relative-path>` (for example, `orb:README.md`) or `orb:/absolute/path`. Percent-encode each path segment. Keep filesystem paths unchanged inside code and commands. Resolve absolute paths with `pwd`/`realpath`; do not assume a workspace root.";
  for (const conversationId of ["root", "child-conversation"]) {
    const rendered = await section?.render({ conversationId } as never, {} as never);
    expect(rendered?.split(rule)).toHaveLength(2);
    expect(rendered).not.toContain("https://files.");
    expect(rendered).not.toContain("/files/");
    expect(rendered).not.toContain("12345678-1234-4234-8234-123456789abc");
    expect(rendered).not.toContain("/workspace");
  }
});
