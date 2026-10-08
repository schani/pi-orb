import type { DisplayRecord, HistoryRecordFrame } from "@pi-orb/protocol";

export function retiredReasoningAliases(
  display: DisplayRecord,
  retiredBlockIds: readonly string[],
  blocks: ReadonlyMap<string, { blockType: "text" | "reasoning"; contentIndex: number }>,
): NonNullable<HistoryRecordFrame["detailAliases"]> {
  if (display.type !== "message") return [];
  const detailKeys = new Set(
    display.content.flatMap((block) => (block.type === "reasoning" ? [block.detailKey] : [])),
  );
  return retiredBlockIds.flatMap((blockId) => {
    const block = blocks.get(blockId);
    if (block?.blockType !== "reasoning") return [];
    const detailKey = `${display.id}:${block.contentIndex}`;
    return detailKeys.has(detailKey) ? [{ blockId, detailKey }] : [];
  });
}
