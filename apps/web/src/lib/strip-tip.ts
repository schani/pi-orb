import type { CSSProperties } from "react";

/**
 * Fixed tooltip above a strip dot. It starts at the dot, or ends at it when the dot is in the
 * right half of the viewport, so long text grows toward the free side instead of being cut off.
 */
export function stripTipStyle(
  dot: { readonly left: number; readonly right: number; readonly top: number },
  viewportWidth: number,
): CSSProperties {
  const top = dot.top - 24;
  if (dot.left < viewportWidth / 2) {
    const left = Math.max(4, dot.left - 16);
    return { left, top, maxWidth: `min(60ch, calc(100vw - ${left + 8}px))` };
  }
  const right = Math.max(4, viewportWidth - dot.right - 16);
  return { right, top, maxWidth: `min(60ch, calc(100vw - ${right + 8}px))` };
}
