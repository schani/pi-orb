import type { CSSProperties } from "react";
import type { RankedUsageOrb } from "../lib/usage.ts";

const exactCount = new Intl.NumberFormat("en-US").format;

export function UsageOrbRankings({ rows }: { rows: readonly RankedUsageOrb[] }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  const values = rows.map((row) => exactCount(row.value) + " tokens");
  const style = {
    "--usage-value-width": Math.max(0, ...values.map((value) => value.length)) + "ch",
  } as CSSProperties;
  return (
    <div className="usage-orb-rankings" style={style}>
      {rows.map((row, index) => (
        <a
          key={row.id}
          className="usage-orb-row"
          href={"/orbs/" + encodeURIComponent(row.id)}
          title={row.label}
        >
          <span className="usage-orb-name">{row.label}</span>
          <span className="usage-orb-plot">
            <span
              className="usage-orb-bar"
              aria-hidden="true"
              style={{ "--share": max === 0 ? 0 : row.value / max } as CSSProperties}
            />
            <span className="usage-orb-value">{values[index]}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
