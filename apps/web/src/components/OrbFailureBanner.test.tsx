import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbFailureBanner } from "./OrbFailureBanner.tsx";

describe("OrbFailureBanner", () => {
  it("renders and escapes the durable failed-state explanation", () => {
    const html = renderToStaticMarkup(
      <OrbFailureBanner message={"runtime_failed: clone_failed: access denied <token>"} />,
    );

    expect(html).toContain("notice notice-error");
    expect(html).toContain('class="rec-px">···<');
    expect(html).toContain("runtime_failed: clone_failed: access denied &lt;token&gt;");
    expect(html).not.toContain("access denied <token>");
  });

  it("renders nothing when the orb has no failure", () => {
    expect(renderToStaticMarkup(<OrbFailureBanner />)).toBe("");
  });
});
