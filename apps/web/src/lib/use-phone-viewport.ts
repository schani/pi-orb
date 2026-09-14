import { type RefObject, useLayoutEffect } from "react";
import { usePhoneLayout } from "./use-phone-layout.ts";

/** One visual-viewport owner for the whole phone orb, not offsets on sticky children. */
export function usePhoneViewport(pageRef: RefObject<HTMLDivElement | null>): void {
  const phone = usePhoneLayout();
  useLayoutEffect(() => {
    const app = pageRef.current?.closest<HTMLElement>(".app");
    if (!phone || !app) return;
    const viewport = window.visualViewport;
    const update = () => {
      // Let native pinch zoom pan the existing layout instead of reflowing it.
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      if (height <= 0) return;
      app.style.setProperty("--phone-viewport-height", `${height}px`);
      app.style.setProperty("--phone-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      app.style.removeProperty("--phone-viewport-height");
      app.style.removeProperty("--phone-viewport-top");
    };
  }, [pageRef, phone]);
}
