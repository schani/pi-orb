import { createHash } from "node:crypto";
import type { MessageInputBlock } from "@pi-orb/protocol";

export function messageBatchId(messageIds: readonly string[]): string {
  const first = messageIds[0];
  if (messageIds.length === 1 && first !== undefined) return first;
  const digest = createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function squashMessageBatch(
  messages: readonly { content: readonly MessageInputBlock[] }[],
): MessageInputBlock[] {
  const content: MessageInputBlock[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (messageIndex > 0) {
      const last = content.at(-1);
      if (last?.type === "text")
        content[content.length - 1] = { ...last, text: `${last.text}\n\n` };
      else content.push({ type: "text", text: "\n\n" });
    }
    for (const block of message.content) {
      const last = content.at(-1);
      if (block.type === "text" && last?.type === "text")
        content[content.length - 1] = { ...last, text: last.text + block.text };
      else content.push(block);
    }
  }
  return content;
}
