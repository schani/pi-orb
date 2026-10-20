import { type RefObject, useLayoutEffect } from "react";

type Listen = {
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};
type Viewport = Listen & { height: number; offsetTop: number; scale: number };
type Host = Listen & { innerHeight: number; visualViewport: Viewport | null };
type Style = { setProperty(name: string, value: string): void; removeProperty(name: string): void };

/** Pins the app box's variables to the visual viewport; returns the cleanup. */
export function followVisualViewport(style: Style, host: Host): () => void {
  const viewport = host.visualViewport;
  const update = () => {
    // Let native pinch zoom pan the existing layout instead of reflowing it.
    if (viewport && viewport.scale !== 1) return;
    const height = viewport?.height ?? host.innerHeight;
    if (height <= 0) return;
    style.setProperty("--visual-viewport-height", `${height}px`);
    style.setProperty("--visual-viewport-top", `${viewport?.offsetTop ?? 0}px`);
  };
  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  host.addEventListener("resize", update);
  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    host.removeEventListener("resize", update);
    style.removeProperty("--visual-viewport-height");
    style.removeProperty("--visual-viewport-top");
  };
}

/**
 * One visual-viewport owner for the whole orb page at every width, not offsets on
 * sticky or fixed children. iOS keyboards and the iPad input-assistant bar shrink
 * and pan only the visual viewport; desktop browsers keep it equal to the layout one.
 */
export function useVisualViewport(pageRef: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const app = pageRef.current?.closest<HTMLElement>(".app");
    return app ? followVisualViewport(app.style, window) : undefined;
  }, [pageRef]);
}
