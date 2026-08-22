import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityBanner } from "./OrbPage.tsx";

describe("IdentityBanner", () => {
  it("reports the last mint failure as history, not as a current-state claim", () => {
    const html = renderToStaticMarkup(
      <IdentityBanner
        identity={{ failureCode: "not_mintable", failureAt: "2026-08-21T09:15:00.000Z" }}
      />,
    );

    expect(html).toContain("banner banner-error");
    // The code and the timestamp are the actionable part: they let the user
    // decide whether the attempt predates whatever they last changed.
    expect(html).toContain("not_mintable");
    expect(html).toContain("2026-08-21T09:15:00.000Z");
    expect(html).toContain("Last workload-identity mint failed");
    // Nothing here may assert that identity is unavailable *now*. The durable
    // columns are never cleared and only a later successful mint supersedes
    // them, so a `not_mintable` denial recorded during an ordinary stop window
    // survives the restart that made the orb healthy again
    // (docs/workload-identity.md). A present-tense banner would then be a
    // standing lie on a perfectly good orb.
    expect(html).not.toContain("unavailable");
    expect(html).not.toContain("since");
  });

  it("renders nothing for an orb with no recorded mint failure", () => {
    expect(renderToStaticMarkup(<IdentityBanner />)).toBe("");
    expect(renderToStaticMarkup(<IdentityBanner identity={undefined} />)).toBe("");
  });
});
