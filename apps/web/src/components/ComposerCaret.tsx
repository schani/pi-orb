import { type RefObject, useLayoutEffect, useRef } from "react";

/** A visual caret only: the native textarea still owns editing, selection, and IME. */
export function ComposerCaret({
  inputRef,
  text,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLSpanElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const before = beforeRef.current;
    const marker = markerRef.current;
    const caret = caretRef.current;
    if (!input || !mirror || !before || !marker || !caret) return;
    let composing = false;

    const update = () => {
      const active = document.activeElement === input && !composing;
      input.dataset["blockCaret"] = String(active);
      caret.hidden = !active || input.selectionStart !== input.selectionEnd;
      if (caret.hidden) return;
      mirror.style.width = `${input.clientWidth}px`;
      before.textContent = input.value.slice(0, input.selectionStart);
      marker.textContent = input.value.slice(input.selectionStart) || "\u200b";
      const bounds = mirror.getBoundingClientRect();
      const position = marker.getClientRects()[0];
      if (!position) return;
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
      const left = position.left - bounds.left - input.scrollLeft;
      const rowTop = Math.round(position.top - bounds.top - (lineHeight - position.height) / 2);
      let top = rowTop - input.scrollTop;
      // Native reveal-scroll exposes the glyph, not the taller line cell.
      // Complete a partially exposed bottom cell without following offscreen selections.
      if (top >= 0 && top < input.clientHeight && top + lineHeight > input.clientHeight) {
        input.scrollTop += top + lineHeight - input.clientHeight;
        top = rowTop - input.scrollTop;
      }
      caret.style.left = `${left}px`;
      caret.style.top = `${top}px`;
      caret.hidden =
        top < 0 || top + lineHeight > input.clientHeight || left < 0 || left >= input.clientWidth;
    };
    updateRef.current = update;
    const compositionStart = () => {
      composing = true;
      update();
    };
    const compositionEnd = () => {
      composing = false;
      update();
    };
    const events = ["input", "select", "keyup", "click", "focus", "blur", "scroll"] as const;
    for (const event of events) input.addEventListener(event, update);
    input.addEventListener("compositionstart", compositionStart);
    input.addEventListener("compositionend", compositionEnd);
    document.addEventListener("selectionchange", update);
    const resize = new ResizeObserver(update);
    resize.observe(input);
    update();
    return () => {
      for (const event of events) input.removeEventListener(event, update);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionend", compositionEnd);
      document.removeEventListener("selectionchange", update);
      resize.disconnect();
      updateRef.current = null;
      delete input.dataset["blockCaret"];
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    void text;
    updateRef.current?.();
  }, [text]);

  return (
    <>
      <div ref={mirrorRef} className="composer-caret-mirror" aria-hidden="true">
        <span ref={beforeRef} />
        <span ref={markerRef} />
      </div>
      <span ref={caretRef} className="composer-caret" aria-hidden="true" hidden />
    </>
  );
}
