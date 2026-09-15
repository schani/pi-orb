import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubagentRail } from "./SubagentRail.tsx";

describe("SubagentRail", () => {
  it("expands once to a flat description-and-phase roster without ID-only disclosures", () => {
    const html = renderToStaticMarkup(
      <SubagentRail
        agents={[
          { id: "internal-running-id", description: "Check services", phase: "running" },
          { id: "internal-queued-id", description: "Check deployment", phase: "queued" },
          { id: "internal-finishing-id", description: "Finish cleanup", phase: "finishing" },
        ]}
      />,
    );
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html.match(/<summary\b/g)).toHaveLength(1);
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html).toContain("Check services");
    expect(html).toContain("Check deployment");
    expect(html).toContain("Finish cleanup");
    expect(html).toContain("1 running");
    expect(html).toContain("1 queued");
    expect(html).toContain("1 finishing");
    expect(html).not.toContain("internal-");
  });
});
