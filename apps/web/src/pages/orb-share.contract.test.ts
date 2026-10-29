import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { IconSprite } from "../components/Icons.tsx";

const page = readFileSync(new URL("./OrbPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

it("groups pencil then Share after the title and before lifecycle, outside rename locking", () => {
  const identity = page.slice(
    page.indexOf('<div className="orb-identity">'),
    page.indexOf("{glyph !== null && lifecycleWord !== null && ("),
  );
  expect(identity).toContain('<div className="orb-identity-actions">');
  expect(identity.indexOf('className="orb-name"')).toBeLessThan(
    identity.indexOf('aria-label="Rename orb"'),
  );
  expect(identity.indexOf('aria-label="Rename orb"')).toBeLessThan(
    identity.indexOf("<OrbShareButton"),
  );
  expect(identity).toMatch(/<OrbShareButton onNotice={setShareNotice}\s*\/>/);
  expect(identity).toContain("orb-rename-form");
  expect(page).toContain("data-phone-actions={phoneActions}");
});

it("announces share notices visibly in the header with existing notice styling", () => {
  expect(page).toMatch(
    /role={shareNotice\?\.error \? "alert" : "status"} aria-live="polite"[\s\S]*?<OrbNotice error={shareNotice.error}>{shareNotice.message}<\/OrbNotice>/,
  );
});

it("uses connected nodes exactly and leaves Upload unchanged", () => {
  const html = renderToStaticMarkup(IconSprite());
  expect(html).toContain('<path d="m5 7 5-3M5 9l5 3"');
  expect(html).toContain('<circle cx="3" cy="8" r="2"');
  expect(html).toContain('<circle cx="12" cy="3" r="2"');
  expect(html).toContain('<circle cx="12" cy="13" r="2"');
  expect(html).toContain('<path d="M3 10v3h10v-3 M8 10V2 M5 5l3-3 3 3"');
});

it("keeps the identity shrinkable and its actions fixed, with 44px phone targets", () => {
  expect(css).toMatch(/\.orb-identity\s*{[^}]*display: flex;[^}]*min-width: 0;/);
  expect(css).toMatch(/\.orb-name\s*{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  expect(css).toMatch(/\.orb-identity-actions\s*{[^}]*flex: none;/);
  expect(css).toMatch(
    /\.orb-identity-actions > \.icon-button\s*{[^}]*width: 44px;[^}]*height: 44px;/,
  );
  expect(css).toContain('.orb-header[data-phone-actions="true"] .orb-header-actions');
});
