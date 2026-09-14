export type IconName =
  | "plus"
  | "pen"
  | "archive"
  | "bin"
  | "x"
  | "copy"
  | "gear"
  | "upload"
  | "start"
  | "stop"
  | "terminal"
  | "fold"
  | "send"
  | "back"
  | "more";

const PATHS: Record<IconName, string> = {
  fold: "m3 6 5 5 5-5",
  send: "M8 13V3M3 8l5-5 5 5",
  back: "M10 3 5 8l5 5",
  more: "M3 8h1m3 0h1m3 0h1",
  plus: "M8 3v10M3 8h10",
  gear: "M6.5 1.5h3l.5 2 1.5 1 2-.5 1.5 2.5-1.5 1.5v1l1.5 1.5-1.5 2.5-2-.5-1.5 1-.5 2h-3l-.5-2-1.5-1-2 .5L1 10.5 2.5 9V8L1 6.5 2.5 4l2 .5 1.5-1z M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0",
  upload: "M3 10v3h10v-3 M8 10V2 M5 5l3-3 3 3",
  start: "M5 3l7 5-7 5z",
  stop: "M4 4h8v8H4z",
  pen: "M3 10 10 3l3 3-7 7H3z M8 5l3 3",
  archive: "M3 6v7h10V6 M2 3h12v3H2z M6 9h4",
  bin: "M4 6h16M9 6V3h6v3M6 9v11h12V9M10 10v6M14 10v6",
  x: "m4 4 8 8m0-8-8 8",
  copy: "M6 6h7v8H6z M3 10H2V2h8v1",
  terminal: "M3 4l4 4-4 4 M9 12h4",
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
          fill={name === "start" || name === "stop" ? "currentColor" : "none"}
          stroke={name === "start" || name === "stop" ? "none" : "currentColor"}
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
