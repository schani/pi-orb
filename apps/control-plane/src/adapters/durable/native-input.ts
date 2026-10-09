import type { UserMessage } from "@earendil-works/pi-ai";
import type { MessageInputBlock, OrbMessageSystem } from "@pi-orb/protocol";

export function nativeInputContent(
  content: readonly MessageInputBlock[],
  system?: OrbMessageSystem,
): UserMessage["content"] {
  const blocks: UserMessage["content"] = content.map((block) =>
    block.type === "text" ? block : { type: "image", data: block.data, mimeType: block.mediaType },
  );
  if (system?.kind === "sleep_wake")
    blocks.unshift({
      type: "text",
      text: "The host was restarted. All processes running before the restart were killed, including servers, background jobs, and shell sessions. The agent session and its history were preserved.",
    });
  return blocks;
}
