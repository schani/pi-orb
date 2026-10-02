import type { LiveDisplayDetail } from "@pi-orb/protocol";
import type { LiveOperationView } from "./types.ts";

export function toolTextContent(candidate: unknown): Array<{ type: "text"; text: string }> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("content" in candidate) ||
    !Array.isArray(candidate.content)
  )
    return [];
  return candidate.content.flatMap((item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [{ type: "text" as const, text: item.text }]
      : [],
  );
}

/** Reasoning mutations update the HTTP-owned snapshot, never grow collapsed WS traffic. */
export function shouldBroadcastOutputPatch(
  blockType: "text" | "reasoning" | "shell",
  hadPrevious: boolean,
): boolean {
  return blockType !== "reasoning" || !hadPrevious;
}

/** Snapshot active body synchronously; no per-viewer state or subscription. */
export function readLiveDisplayDetail(
  sessionId: string,
  live: LiveOperationView | null,
  operationId: string,
  blockId: string,
): LiveDisplayDetail {
  const block =
    live?.operationId === operationId
      ? live.blocks.find((entry) => entry.blockId === blockId)
      : undefined;
  return {
    v: 1,
    sessionId,
    operationId,
    blockId,
    state: block === undefined ? "unavailable" : "running",
    ...(block === undefined
      ? {}
      : {
          body: {
            type: block.blockType === "reasoning" ? ("reasoning" as const) : ("shell" as const),
            text: block.text,
          },
        }),
  };
}
