import {
  type DisplayBlock,
  type HistoryRecord,
  type JsonValue,
  projectDisplayRecord,
  projectRecordDetail,
} from "@pi-orb/protocol";

const TOOL_EXCERPT_LENGTH = 2_000;
const SNIPPET_LENGTH = 500;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

export interface HistorySearchTermFrequencies {
  tokenCount: number;
  termFrequencies: Record<string, number>;
}

function normalizeHistorySearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

export function tokenizeHistorySearchText(text: string): string[] {
  return normalizeHistorySearchText(text).match(WORD) ?? [];
}

export function historySearchQueryTerms(query: string): string[] {
  return [...new Set(tokenizeHistorySearchText(query))];
}

export function historySearchTermFrequencies(text: string): HistorySearchTermFrequencies {
  const tokens = tokenizeHistorySearchText(text);
  const termFrequencies: Record<string, number> = Object.create(null);
  for (const token of tokens) termFrequencies[token] = (termFrequencies[token] ?? 0) + 1;
  return { tokenCount: tokens.length, termFrequencies };
}

/** Visit only public arguments, with bounded work even for deep or wide JSON. */
function argumentExcerpt(value: JsonValue): string {
  let excerpt = "";
  let remaining = TOOL_EXCERPT_LENGTH;
  const append = (part: string) => {
    if (excerpt !== "") excerpt += "\n";
    excerpt += part.slice(0, TOOL_EXCERPT_LENGTH - excerpt.length);
  };
  const visit = (item: JsonValue, depth: number): void => {
    if (remaining-- <= 0 || depth > 20 || excerpt.length >= TOOL_EXCERPT_LENGTH) return;
    if (item === null || typeof item !== "object") {
      append(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        if (remaining <= 0 || excerpt.length >= TOOL_EXCERPT_LENGTH) break;
        visit(child, depth + 1);
      }
    } else {
      for (const key in item) {
        if (remaining <= 0 || excerpt.length >= TOOL_EXCERPT_LENGTH) break;
        if (!Object.hasOwn(item, key)) continue;
        append(key);
        visit(item[key] ?? null, depth + 1);
      }
    }
  };
  visit(value, 0);
  return excerpt.slice(0, TOOL_EXCERPT_LENGTH);
}

function blockText(record: HistoryRecord, blocks: readonly DisplayBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type !== "tool_call" && block.type !== "tool_result") return [];
    const detail = projectRecordDetail(record, block.detailKey);
    if (detail?.type === "tool_call")
      return [
        `${block.type === "tool_call" ? block.name : ""}\n${argumentExcerpt(detail.arguments)}`.slice(
          0,
          TOOL_EXCERPT_LENGTH,
        ),
      ];
    if (detail?.type === "tool_result") {
      let excerpt = "";
      for (const leaf of detail.content) {
        if (leaf.type !== "text") continue;
        if (excerpt !== "") excerpt += "\n";
        excerpt += leaf.text.slice(0, TOOL_EXCERPT_LENGTH - excerpt.length);
        if (excerpt.length >= TOOL_EXCERPT_LENGTH) break;
      }
      return [excerpt];
    }
    return [];
  });
}

function nativeCommandEcho(record: HistoryRecord): boolean {
  if (record.type !== "message" || record.role !== "user" || record.inboxMessageIds !== undefined)
    return false;
  const native = record.overflow.native;
  if (
    native === null ||
    typeof native !== "object" ||
    Array.isArray(native) ||
    native.type !== "user"
  )
    return false;
  const message = native.message;
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.role === "user" &&
    typeof message.content === "string" &&
    /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(message.content)
  );
}

/** Public root-record text only; never walk native payloads, overflow or child history. */
export function extractHistorySearchText(record: HistoryRecord): string {
  if (record.type === "message" && (record.role === "system" || record.role === "developer"))
    return "";
  if (nativeCommandEcho(record)) return "";
  const display = projectDisplayRecord(record);
  if (display.type === "compaction") {
    const detail = projectRecordDetail(record, display.detailKey);
    return detail?.type === "compaction" ? detail.text : "";
  }
  const parts = blockText(record, display.content ?? []);
  if (display.type === "message") {
    if (display.failure !== undefined) parts.push(display.failure.message);
  } else {
    if (display.alert !== undefined) parts.push(display.alert.message);
    if (display.delivery?.detailKey !== undefined) {
      const detail = projectRecordDetail(record, display.delivery.detailKey);
      if (detail?.type === "delivery") parts.push(detail.text);
    }
    if (display.subagent !== undefined) {
      const notice = display.subagent;
      if (notice.description !== undefined) parts.push(notice.description);
      if (notice.status !== undefined) parts.push(notice.status);
      const detail = projectRecordDetail(record, notice.detailKey);
      if (detail?.type === "subagent") {
        for (const text of [detail.message, detail.notice, detail.error, detail.resultPreview])
          if (text !== undefined) parts.push(text);
      }
    }
  }
  return parts.filter((part) => part !== "").join("\n");
}

export function historySearchSnippet(text: string, queryTerms: readonly string[]): string {
  if (text.length <= SNIPPET_LENGTH) return text;
  const terms = new Set(queryTerms);
  let matchIndex = 0;
  for (const match of normalizeHistorySearchText(text).matchAll(WORD)) {
    if (!terms.has(match[0])) continue;
    // Find the source character that contributes the normalized token start.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (normalizeHistorySearchText(text.slice(0, middle)).length <= match.index) low = middle + 1;
      else high = middle;
    }
    matchIndex = Math.max(0, low - 1);
    break;
  }
  const width = SNIPPET_LENGTH - 2;
  let start = Math.max(0, Math.min(matchIndex - Math.floor(width / 2), text.length - width));
  let end = Math.min(text.length, start + width);
  // Do not introduce broken surrogate pairs when cutting a lossless source string.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
