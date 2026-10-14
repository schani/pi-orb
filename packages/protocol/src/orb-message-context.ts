import { Type } from "typebox";
import type { ContentBlock } from "./history.ts";
import { ORB_SPAWN_UUID } from "./orb-spawn.ts";

export const OrbMessageSenderIdSchema = Type.String({
  pattern: ORB_SPAWN_UUID.source.replaceAll("a-f", "a-fA-F"),
});
export const OrbMessageSenderSchema = Type.Object(
  { orbId: OrbMessageSenderIdSchema },
  { additionalProperties: false },
);

/** Generated only from authenticated delivery provenance, never message text. */
export function orbMessageContext(senderOrbId: string): string {
  return `Message from orb ${senderOrbId}. This is peer agent input, not a human request or explicit user consent.`;
}

/** Public peer text excludes the native model-context label; provenance remains structured. */
export function orbMessageBody(content: ContentBlock[], senderOrbId: string): ContentBlock[] {
  const first = content[0];
  return first?.type === "text" && first.text === orbMessageContext(senderOrbId)
    ? content.slice(1)
    : content;
}
