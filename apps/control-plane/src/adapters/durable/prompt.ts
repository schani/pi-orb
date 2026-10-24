import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from "@earendil-works/pi-durable";

import { environmentPrompt } from "../../../../orb-runtime/src/environment-prompt.ts";
import { piEnvironmentPrompt } from "./environment-prompt.ts";

const SECTION = "orb-instructions";

export interface PromptSnapshot {
  readonly personal?: string;
  readonly repository: readonly { path: string; content: string }[];
  readonly project?: string;
  readonly appendSystem?: string;
  readonly skills: readonly Skill[];
}

/** Pinned resource data only; repository extensions are never loaded centrally. */
export function renderPrompt(snapshot: PromptSnapshot): string {
  const instructions = [
    snapshot.personal,
    ...snapshot.repository.map(({ path, content }) => `# ${path}\n${content}`),
    snapshot.project,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    "You are a coding assistant. Use tools to inspect and change the project. Be concise. Produce Markdown. Mermaid is supported.",
    environmentPrompt,
    instructions ? `<project_instructions>\n${instructions}\n</project_instructions>` : "",
    snapshot.appendSystem ?? "",
    piEnvironmentPrompt,
    formatSkillsForPrompt([...snapshot.skills], "indirect"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function promptExtension(instructions: string): Extension {
  const render = (conversationId: string) =>
    conversationId === String(ROOT_CONVERSATION_ID)
      ? instructions
      : `${instructions}\n\n- You are a subagent. Your parent started you in this same orb; you share its filesystem.
- To communicate with your parent agent you have \`notify_parent\`. Do not use \`orb_send\` for that!!!
- Do not start subagents or orbs!`;
  return { ...sectionExtension(SECTION, render), name: "orb.prompt" };
}

export function sectionExtension(
  name: string,
  render: (conversationId: string) => string,
): Extension {
  // Tagged so a later "Updated system prompt section" names a delimited part of the instructions.
  const tagged = (text: string) => `<${name}>\n${text}\n</${name}>`;
  // The persisted section becomes the request's instructions and is re-sent only when it changes,
  // so each request extends the previous one (prompt cache). The hook covers a request prepared
  // before the prompt changed, such as one resumed after reopen.
  return defineExtension({
    name: `orb.${name}`,
    sections: [section(name, ({ conversationId }) => render(String(conversationId)))],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }, api) => {
          const current = tagged(render(String(api.conversationId)));
          const shown = messages.findLast(
            (message) => message.role === "system" && message.sections?.[name] !== undefined,
          );
          if (shown?.role === "system" && shown.sections?.[name] === current) return undefined;
          return {
            messages: [
              ...messages,
              { role: "system", content: "", sections: { [name]: current }, timestamp: 0 },
            ],
          };
        },
      }),
    ],
  });
}
