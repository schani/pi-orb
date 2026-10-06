import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";

export interface PromptSnapshot {
  readonly cwd: string;
  readonly personal?: string;
  readonly repository: readonly { path: string; content: string }[];
  readonly project?: string;
  readonly appendSystem?: string;
  readonly skills: readonly Skill[];
}

/** Snapshot data comes from guest RPC; executable repository extensions are never loaded centrally. */
export function renderPrompt(snapshot: PromptSnapshot): string {
  const instructions = [
    snapshot.personal,
    ...snapshot.repository.map(({ path, content }) => `# ${path}\n${content}`),
    snapshot.project,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    "You are a coding assistant. Use tools to inspect and change the project. Be concise.",
    instructions ? `<project_instructions>\n${instructions}\n</project_instructions>` : "",
    snapshot.appendSystem ?? "",
    formatSkillsForPrompt([...snapshot.skills]),
    `<cwd>\n${snapshot.cwd}\n</cwd>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function promptExtension(
  instructions: string | ((conversationId: string, generationId?: string) => string),
): Extension {
  const render = (conversationId: string, generationId?: string) =>
    typeof instructions === "string" ? instructions : instructions(conversationId, generationId);
  return defineExtension({
    name: "orb.prompt",
    sections:
      typeof instructions === "string"
        ? [section("orb-instructions", () => instructions, { tag: false })]
        : [],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }, api) => ({
          messages: [
            ...messages,
            {
              role: "system",
              content: "",
              sections: {
                "orb-instructions": render(String(api.conversationId), String(api.taskId)),
              },
              timestamp: 0,
            },
          ],
        }),
      }),
    ],
  });
}
