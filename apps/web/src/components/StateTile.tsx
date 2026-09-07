import type { OrbGlyph } from "../lib/project-orbs.ts";

/** The browser favicon asset is also the UI mark; geometry cannot drift. */
export function StateTile({
  glyph,
  decorative = false,
}: {
  glyph: OrbGlyph;
  decorative?: boolean;
}) {
  return (
    <img
      className={`glyph s-${glyph.state}`}
      src={glyph.iconHref}
      width={16}
      height={16}
      alt={decorative ? "" : glyph.label}
      title={glyph.label}
    />
  );
}
