export type IconName =
  | "pen"
  | "archive"
  | "bin"
  | "minus"
  | "x"
  | "copy"
  | "clear"
  | "restart"
  | "gear";

const PATHS: Record<IconName, string> = {
  gear: "M6.5 1.5h3l.5 2 1.5 1 2-.5 1.5 2.5-1.5 1.5v1l1.5 1.5-1.5 2.5-2-.5-1.5 1-.5 2h-3l-.5-2-1.5-1-2 .5L1 10.5 2.5 9V8L1 6.5 2.5 4l2 .5 1.5-1z M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0",
  pen: "M3 10 10 3l3 3-7 7H3z M8 5l3 3",
  archive: "M3 6v7h10V6 M2 3h12v3H2z M6 9h4",
  bin: "M4 6h16M9 6V3h6v3M6 9v11h12V9M10 10v6M14 10v6",
  minus: "M3 8h10",
  x: "m4 4 8 8m0-8-8 8",
  copy: "M6 6h7v8H6z M3 10H2V2h8v1",
  clear: "M2.5 6.5h11v6h-11z M7 6.5 5 12.5",
  restart: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2 M11 3.5v2h2",
};

/** Square-ended utility controls; the crisp bin retains its selected 24px geometry. */
export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true" focusable="false">
      {Object.entries(PATHS).map(([name, path]) => (
        <symbol
          key={name}
          id={`i-${name}`}
          viewBox={name === "bin" ? "0 0 24 24" : "0 0 16 16"}
          fill="none"
          stroke="currentColor"
          strokeWidth={name === "bin" ? "1.9" : "1.5"}
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
