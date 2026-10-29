import { type RefObject, useLayoutEffect } from "react";
import { devConsoleDebug } from "./dev-console-debug.ts";

type Listen = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};
type Viewport = Listen & { height: number; offsetTop: number; scale: number };
type Host = Listen & {
  innerHeight: number;
  navigator: Pick<Navigator, "userAgent">;
  visualViewport: Viewport | null;
  document: Listen & { visibilityState: string };
};
type Style = { setProperty(name: string, value: string): void; removeProperty(name: string): void };

/** Pins the app box's variables to the visual viewport; returns the cleanup. */
export function followVisualViewport(style: Style, host: Host): () => void {
  const viewport = host.visualViewport;
  const iphone = /iPhone|iPod/.test(host.navigator.userAgent);
  let applied: { height: number; top: number; accessoryInset: number } | undefined;
  const update = () => {
    // Let native pinch zoom pan the existing layout instead of reflowing it.
    if (viewport && viewport.scale !== 1) return;
    const height = viewport?.height ?? host.innerHeight;
    if (height <= 0) return;
    const top = viewport?.offsetTop ?? 0;
    // iOS's floating form accessory can overlap the visual viewport. Its native
    // bounds are not exposed; reserve the screenshot's pill + gap on keyboard shrink.
    const accessoryInset = iphone && host.innerHeight - height > 150 ? 60 : 0;
    if (
      applied?.height === height &&
      applied.top === top &&
      applied.accessoryInset === accessoryInset
    )
      return;
    style.setProperty("--visual-viewport-height", `${height}px`);
    style.setProperty("--visual-viewport-top", `${top}px`);
    style.setProperty("--keyboard-accessory-inset", `${accessoryInset}px`);
    if (accessoryInset !== (applied?.accessoryInset ?? 0))
      devConsoleDebug.record({
        event: "viewport",
        outcome: accessoryInset ? "accessory_available" : "accessory_unavailable",
        viewportHeight: height,
        viewportLayoutHeight: host.innerHeight,
        viewportOffsetTop: top,
      });
    applied = { height, top, accessoryInset };
    return applied;
  };
  const resume = (outcome: "visible" | "pageshow" | "focus") => {
    if (host.document.visibilityState !== "visible") return;
    const changed = update();
    if (changed)
      devConsoleDebug.record({
        event: "viewport",
        outcome,
        viewportHeight: changed.height,
        viewportOffsetTop: changed.top,
      });
  };
  const visible = () => resume("visible");
  const pageshow = () => resume("pageshow");
  const focus = () => resume("focus");
  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  host.addEventListener("resize", update);
  host.document.addEventListener("visibilitychange", visible);
  host.addEventListener("pageshow", pageshow);
  host.addEventListener("focus", focus);
  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    host.removeEventListener("resize", update);
    host.document.removeEventListener("visibilitychange", visible);
    host.removeEventListener("pageshow", pageshow);
    host.removeEventListener("focus", focus);
    style.removeProperty("--visual-viewport-height");
    style.removeProperty("--visual-viewport-top");
    style.removeProperty("--keyboard-accessory-inset");
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
