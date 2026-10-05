export type ComposerMode = "message" | "command";

export interface ComposerValue {
  mode: ComposerMode;
  text: string;
}

export function composerModeGlyph(mode: ComposerMode): ">" | "/" {
  return mode === "command" ? "/" : ">";
}

/** Enter command mode for paste, mobile input, and whole-value replacement. */
export function normalizeComposerChange(mode: ComposerMode, text: string): ComposerValue {
  if (mode === "message" && text.startsWith("/")) return { mode: "command", text: text.slice(1) };
  return { mode, text };
}
