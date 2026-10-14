import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UsageOrbRankings } from "./UsageOrbRankings.tsx";

it("renders one native link per ID with full labels, encoded routes, exact counts and proportional bars", () => {
  const label = "A very long duplicate orb name ".repeat(8);
  const html = renderToStaticMarkup(
    <UsageOrbRankings
      rows={[
        { id: "a/b", label, value: 2000000 },
        { id: "b", label, value: 1000000 },
        { id: "c", label: "c", value: 0 },
      ]}
    />,
  );
  expect(html.match(/<a /g)).toHaveLength(3);
  expect(html).toContain('href="/orbs/a%2Fb"');
  expect(html).toContain(">" + label + "</span>");
  expect(html).toContain("2,000,000 tokens");
  expect(html).toContain("0 tokens");
  expect(html).toContain("--share:1");
  expect(html).toContain("--share:0.5");
  expect(html).toContain("--share:0");
});

it("renders all-zero rankings without invalid widths", () => {
  const html = renderToStaticMarkup(
    <UsageOrbRankings rows={[{ id: "a", label: "a", value: 0 }]} />,
  );
  expect(html).toContain("--share:0");
  expect(html).not.toMatch(/NaN|Infinity/);
});
