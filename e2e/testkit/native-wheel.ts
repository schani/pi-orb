interface WheelPane extends EventTarget {
  scrollTop: number;
  scrollHeight: number;
}

/**
 * One outstanding arm: prior input complete, layout settled, no independent scrolling.
 * The owning page closes unfinished gates.
 */
export function armNativeWheel(element: WheelPane): void {
  const top = element.scrollTop;
  let height = 0;
  let wheelSeen = false;
  let moved = false;
  const finished = new Promise<void>((resolve) => {
    const wheel = () => {
      if (wheelSeen) return;
      height = element.scrollHeight;
      wheelSeen = true;
    };
    const scroll = () => {
      if (wheelSeen && (element.scrollTop !== top || element.scrollHeight !== height)) moved = true;
    };
    const end = () => {
      if (!moved) return;
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("scrollend", end);
      resolve();
    };
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("scroll", scroll);
    element.addEventListener("scrollend", end);
  });
  Reflect.set(element, "wheelFinished", finished);
}
