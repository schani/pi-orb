// Adapted from Pi 1.0.0; scoped spilling replaces OS temp files. See PROVENANCE.md and LICENSE.
import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";

const CHARS_PER_TOKEN = 4;
/**
 * Apply the token budget: when the combined text exceeds it, the text items become one
 * item that keeps the start and end of the text, and images follow it. The full text is written to
 * a temp file.
 */
export async function truncateOutput(
  items: CodemodeOutputItem[],
  maxTokens: number,
  spillOutput: (text: string) => Promise<{ path: string } | { error: string }>,
): Promise<{ items: CodemodeOutputItem[]; fullOutputPath?: string }> {
  const texts = items
    .filter((item): item is Extract<CodemodeOutputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text);
  const combined = texts.join("\n");
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) return { items };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = combined.slice(0, headChars);
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
  let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
  const spilled = await spillOutput(combined);
  text +=
    "path" in spilled
      ? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
      : `\n\n[Could not save the full output: ${spilled.error}]`;
  return {
    items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
    ...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
  };
}
