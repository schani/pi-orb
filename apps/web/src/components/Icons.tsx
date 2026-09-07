export type IconName = "pen" | "archive" | "bin" | "minus" | "x" | "copy" | "clear" | "restart";

const PATHS: Record<IconName, string> = {
  pen: "M3 10 10 3l3 3-7 7H3z M8 5l3 3",
  archive: "M3 6v7h10V6 M2 3h12v3H2z M6 9h4",
  bin: "M4 5v8h8V5 M2 3h12 M6 1h4 M6 7v4 M10 7v4",
  minus: "M3 8h10",
  x: "m4 4 8 8m0-8-8 8",
  copy: "M6 6h7v8H6z M3 10H2V2h8v1",
  clear: "M2.5 6.5h11v6h-11z M7 6.5 5 12.5",
  restart: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2 M11 3.5v2h2",
};

/** Instrument tile controls share a 16px grid and 1.5px square-ended strokes. */
export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true" focusable="false">
      {Object.entries(PATHS).map(([name, path]) => (
        <symbol
          key={name}
          id={`i-${name}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        >
          <path d={path} />
        </symbol>
      ))}
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
