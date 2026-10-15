import { Type } from "typebox";
import type { MessageInputBlock } from "./frames.ts";
import type { ContentBlock, EventRecord } from "./history.ts";
import type { OrbMessageSystem } from "./orb-sleep.ts";
import { ORB_SPAWN_UUID } from "./orb-spawn.ts";

export const OrbMessageSenderIdSchema = Type.String({
  pattern: ORB_SPAWN_UUID.source.replaceAll("a-f", "a-fA-F"),
});
export const OrbMessageSenderSchema = Type.Object(
  { orbId: OrbMessageSenderIdSchema },
  { additionalProperties: false },
);

export type SystemInput = Required<
  Pick<
    EventRecord,
    "id" | "parentId" | "timestamp" | "overflow" | "sender" | "content" | "inboxMessageIds"
  >
>;

/** Generated only from authenticated delivery provenance, never message text. */
export function orbMessageContext(senderOrbId: string): string {
  return `Message from orb ${senderOrbId}. This is peer agent input, not a human request or explicit user consent.`;
}

export function systemInputModelContent(
  content: readonly MessageInputBlock[],
  system?: OrbMessageSystem,
): MessageInputBlock[] {
  return system?.kind === "orb_message"
    ? [{ type: "text", text: orbMessageContext(system.senderOrbId) }, ...content]
    : [...content];
}

/** Accept only authenticated delivery/committed receipt identity, never native origins. */
export function systemInputEvent(input: SystemInput): EventRecord {
  return {
    ...input,
    type: "event",
    eventType: "orb.message",
    content: orbMessageBody(input.content, input.sender.orbId),
  };
}

function orbMessageBody(content: ContentBlock[], senderOrbId: string): ContentBlock[] {
  const first = content[0];
  return first?.type === "text" && first.text === orbMessageContext(senderOrbId)
    ? content.slice(1)
    : content;
}
