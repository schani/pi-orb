export type ComposerMode = "message" | "shell" | "excluded_shell";

export interface ComposerValue {
  mode: ComposerMode;
  text: string;
}

export function composerModeLabel(mode: ComposerMode): "message" | "shell" | "excluded shell" {
  return mode === "excluded_shell" ? "excluded shell" : mode;
}

/** Consume a bang typed at offset zero as a hidden mode prefix when possible. */
export function enterShellMode(mode: ComposerMode): ComposerMode | null {
  if (mode === "message") return "shell";
  if (mode === "shell") return "excluded_shell";
  return null;
}

/** Backspace at offset zero removes one hidden prefix without changing text. */
export function leaveShellMode(mode: ComposerMode): ComposerMode | null {
  if (mode === "excluded_shell") return "shell";
  if (mode === "shell") return "message";
  return null;
}

/**
 * Normalize text insertion paths that bypass keydown, notably paste, mobile
 * input, and whole-value replacement. Prefixes become mode state and never
 * remain visible in the textarea.
 */
export function normalizeComposerChange(mode: ComposerMode, text: string): ComposerValue {
  if (mode === "message" && text.startsWith("!!")) {
    return { mode: "excluded_shell", text: text.slice(2) };
  }
  if (text.startsWith("!")) {
    const nextMode = enterShellMode(mode);
    if (nextMode !== null) return { mode: nextMode, text: text.slice(1) };
  }
  return { mode, text };
}
