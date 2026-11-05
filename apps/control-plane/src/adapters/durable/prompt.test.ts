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

it("renders the trusted per-orb files URL in root and child instructions", () => {
  const filesBaseUrl = "https://f-o12345678-1234-4234-8234-123456789abc.preview.example.net";
  const prompt = renderPrompt({ repository: [], skills: [], filesBaseUrl });
  expect(prompt).toContain(`absolute path under ${filesBaseUrl},`);
  expect(prompt.split(filesBaseUrl)).toHaveLength(2);
  expect(renderPrompt({ repository: [], skills: [], filesBaseUrl: null })).not.toContain(
    "absolute path under",
  );
});

it("keeps the orb's files origin in root and child sections, never a child-conversation ID", async () => {
  const filesBaseUrl = "https://f-o12345678-1234-4234-8234-123456789abc.preview.example.net";
  const extension = promptExtension(renderPrompt({ repository: [], skills: [], filesBaseUrl }));
  const section = extension.sections![0]!;
  for (const conversationId of ["root", "child-conversation"]) {
    const rendered = await section.render({ conversationId } as never, {} as never);
    expect(rendered).toContain(`absolute path under ${filesBaseUrl},`);
    expect(rendered).not.toContain("f-ochild-conversation");
  }
});
