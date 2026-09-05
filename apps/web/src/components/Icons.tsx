export type IconName = "pen" | "archive" | "bin" | "minus" | "x" | "copy" | "clear" | "restart";

/** One inline sprite, rendered once by the app shell. */
export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true" focusable="false">
      <symbol
        id="i-pen"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M3 13l1-3 7-7 2 2-7 7-3 1z" />
        <path d="M10 4l2 2" />
      </symbol>
      <symbol
        id="i-archive"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M2.5 3.5h11v9h-11z" />
        <path d="M2.5 6.5h11" />
        <path d="M6.5 9.5h3" />
      </symbol>
      <symbol
        id="i-bin"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M2.5 4.5h11" />
        <path d="M4.2 4.5 5 13.5h6l.8-9" />
        <path d="M8 7v4" />
      </symbol>
      <symbol
        id="i-minus"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M3.5 8h9" />
      </symbol>
      <symbol
        id="i-x"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M4 4 12 12" />
        <path d="M12 4 4 12" />
      </symbol>
      <symbol
        id="i-clear"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M2.5 6.5h11v6h-11z" />
        <path d="M7 6.5 5 12.5" />
      </symbol>
      <symbol
        id="i-restart"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" />
        <path d="M11 3.5v2h2" />
      </symbol>
      <symbol
        id="i-copy"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M5.5 2.5h8v8h-8z" />
        <path d="M2.5 5.5h8v8h-8z" />
      </symbol>
    </svg>
  );
}

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ic" aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
