import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HarnessIcon } from "./HarnessIcon.tsx";
import { ProjectNewOrbLink } from "./ProjectNewOrbLink.tsx";

it("preserves the approved Pi tile and authentic Claude asterisk geometry", () => {
  const pi = renderToStaticMarkup(<HarnessIcon harness="pi" />);
  expect(pi).toContain('viewBox="0 0 16 16"');
  expect(pi).toContain('fill="#555555"');
  expect(pi).toContain('d="M4 5h8M6 5v3.5Q6 10 5 11M10 5v5q0 1 1 1"');
  const claude = renderToStaticMarkup(<HarnessIcon harness="claude" />);
  expect(claude).toContain('viewBox="0 0 24 24"');
  expect(claude).toContain('fill="currentColor"');
  const path = claude.match(/<path d="([^"]+)"/)?.[1] ?? "";
  expect(createHash("sha256").update(path).digest("hex")).toBe(
    "0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84",
  );
});

it.each(["pi", "claude"] as const)(
  "uses a link-native %s intent with decorative SVG and no visible label",
  (harness) => {
    const html = renderToStaticMarkup(
      <ProjectNewOrbLink
        project={{ id: "project/one", name: "Signal" }}
        harness={harness}
        disabled={false}
        onClick={() => {}}
      />,
    );
    expect(html).toContain(`href="/projects/project%2Fone/orbs/new?harness=${harness}"`);
    expect(html).toContain(`aria-label="New ${harness === "pi" ? "Pi" : "Claude"} orb in Signal"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/>New|>Pi|>Claude|#i-plus/);
    const disabled = renderToStaticMarkup(
      <ProjectNewOrbLink
        project={{ id: "project", name: "Signal" }}
        harness={harness}
        disabled
        onClick={() => {}}
      />,
    );
    expect(disabled).toContain('disabled=""');
    expect(disabled).not.toContain("href=");
  },
);
