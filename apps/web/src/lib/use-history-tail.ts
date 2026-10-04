import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { initialTailIndex, retainedTailIndex, upwardRevealIndex } from "./history-tail.ts";

/** The parent owns tail-following; this hook anchors off-tail readers and reveals upward. */
export function useHistoryTail(
  keys: readonly string[],
  historyRef: RefObject<HTMLDivElement | null>,
  viewportRef?: RefObject<HTMLDivElement | null>,
  onCompensatedRef?: RefObject<(() => void) | null>,
): number {
  const [first, setFirst] = useState<string | null>(
    () => keys[initialTailIndex(keys.length)] ?? null,
  );
  const index = retainedTailIndex(keys, first);
  const retainedFirst = keys[index] ?? null;
  if (retainedFirst !== first) setFirst(retainedFirst);
  const latest = useRef({ keys, index });
  latest.current = { keys, index };
  const restoreRef = useRef<(() => void) | null>(null);

  // Ancestor DOM refs attach after child layout effects.
  useEffect(() => {
    const viewport = viewportRef?.current;
    const history = historyRef.current;
    if (!viewport || !history) return;
    const control = attachHistoryTail(
      viewport,
      history,
      () => latest.current.index,
      (next) => {
        setFirst(latest.current.keys[next] ?? null);
      },
      () => onCompensatedRef?.current?.(),
    );
    restoreRef.current = control.restore;
    return () => {
      restoreRef.current = null;
      control.dispose();
    };
  }, [historyRef, viewportRef, onCompensatedRef]);

  useLayoutEffect(() => {
    restoreRef.current?.();
  });
  return index;
}

export function attachHistoryTail(
  viewport: HTMLDivElement,
  history: HTMLDivElement,
  firstIndex: () => number,
  onReveal: (index: number) => void,
  onCompensated?: () => void,
): { restore: () => void; dispose: () => void } {
  const previousAnchorStyle = viewport.style.overflowAnchor;
  viewport.style.overflowAnchor = "none";
  let anchor: { element: HTMLElement; offset: number } | null = null;
  let upwardIntent = false;
  let pointer = false;
  let touchY: number | null = null;
  let previousTop = viewport.scrollTop;
  let adjusting = false;
  const capture = () => {
    previousTop = viewport.scrollTop;
    const top = viewport.getBoundingClientRect().top;
    const element = Array.from(history.querySelectorAll<HTMLElement>("[data-history-row]")).find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    anchor = element ? { element, offset: element.getBoundingClientRect().top - top } : null;
  };
  const restore = () => {
    // Native movement can precede its scroll event and the next layout/resize.
    if (Math.abs(viewport.scrollTop - previousTop) > 1) {
      adjusting = false;
      capture();
      return;
    }
    if (!anchor?.element.isConnected) return;
    const delta =
      anchor.element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      anchor.offset;
    if (Math.abs(delta) > 0.5) {
      adjusting = true;
      viewport.scrollTop += delta;
      previousTop = viewport.scrollTop;
      onCompensated?.();
    }
  };
  const reveal = () => {
    const currentIndex = firstIndex();
    const next = upwardRevealIndex(currentIndex, viewport.scrollTop, true);
    if (next === currentIndex) return;
    capture();
    onReveal(next);
  };
  const upward = () => {
    upwardIntent = true;
    capture();
    reveal();
  };
  const clearIntent = () => {
    adjusting = false;
    upwardIntent = false;
    if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) anchor = null;
    else capture();
  };
  const onWheel = (event: WheelEvent) => {
    adjusting = false;
    if (event.deltaY < 0) upward();
    else clearIntent();
  };
  const onKey = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, select, [contenteditable]")
    )
      return;
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
      (event.key === " " && event.shiftKey)
    ) {
      adjusting = false;
      upward();
    } else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) clearIntent();
  };
  const onPointerDown = () => {
    pointer = true;
    clearIntent();
  };
  const onPointerUp = () => {
    pointer = false;
  };
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY ?? null;
    if (y !== null && touchY !== null) {
      adjusting = false;
      if (y > touchY) upward();
      else clearIntent();
    }
    touchY = y;
  };
  const onScroll = () => {
    const top = viewport.scrollTop;
    if (adjusting && Math.abs(top - previousTop) < 1) {
      adjusting = false;
      return;
    }
    const movedUp = top < previousTop;
    previousTop = top;
    if (top + viewport.clientHeight >= viewport.scrollHeight - 1) clearIntent();
    else if (pointer && movedUp) upward();
    else {
      capture();
      if (upwardIntent && movedUp) reveal();
    }
  };
  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("keydown", onKey);
  viewport.addEventListener("pointerdown", onPointerDown, { passive: true });
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("pointercancel", onPointerUp, { passive: true });
  viewport.addEventListener("touchstart", onTouchStart, { passive: true });
  viewport.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  const observer = new ResizeObserver(restore);
  observer.observe(history);
  observer.observe(viewport);
  return {
    restore,
    dispose: () => {
      observer.disconnect();
      viewport.style.overflowAnchor = previousAnchorStyle;
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKey);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("pointercancel", onPointerUp);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerup", onPointerUp);
    },
  };
}
