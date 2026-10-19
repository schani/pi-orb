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
export function renderPrompt(
  snapshot: PromptSnapshot,
  text: { preamble?: string; environment?: string; piEnvironment?: string } = {},
): string {
  const instructions = [
    snapshot.personal,
    ...snapshot.repository.map(({ path, content }) => `# ${path}\n${content}`),
    snapshot.project,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    text.preamble ??
      "You are a coding assistant. Use tools to inspect and change the project. Be concise.",
    instructions ? `<project_instructions>\n${instructions}\n</project_instructions>` : "",
    snapshot.appendSystem ?? "",
    text.environment ?? environmentPrompt,
    text.piEnvironment ?? piEnvironmentPrompt,
    formatSkillsForPrompt([...snapshot.skills]),
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
  // Tagged so a later "Updated system prompt section" names a delimited part of the instructions.
  const tagged = (text: string) => `<${SECTION}>\n${text}\n</${SECTION}>`;
  // The persisted section becomes the request's instructions and is re-sent only when it changes,
  // so each request extends the previous one (prompt cache). The hook covers a request prepared
  // before the prompt changed, such as one resumed after reopen.
  return defineExtension({
    name: "orb.prompt",
    sections: [section(SECTION, ({ conversationId }) => render(String(conversationId)))],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }, api) => {
          const current = tagged(render(String(api.conversationId)));
          const shown = messages.findLast(
            (message) => message.role === "system" && message.sections?.[SECTION] !== undefined,
          );
          if (shown?.role === "system" && shown.sections?.[SECTION] === current) return undefined;
          return {
            messages: [
              ...messages,
              { role: "system", content: "", sections: { [SECTION]: current }, timestamp: 0 },
            ],
          };
        },
      }),
    ],
  });
}
