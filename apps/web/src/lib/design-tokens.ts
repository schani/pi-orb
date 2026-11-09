/** Mermaid derives colors from what it is given, so it takes resolved values, one set per theme. */
export const TOKENS = {
  light: {
    w: "#fff",
    k: "#000",
    g1: "#f2f2f2",
    g1x: "#ddd",
    g2: "#999",
    g3: "#555",
    bad: "#b42318",
  },
  dark: {
    w: "#000",
    k: "#fff",
    g1: "#1a1a1a",
    g1x: "#333",
    g2: "#666",
    g3: "#aaa",
    bad: "#ff7a6b",
  },
} as const;

export type ColorScheme = keyof typeof TOKENS;
